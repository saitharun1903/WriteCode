import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { QueueEvents } from "bullmq";
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@cw/db";
import {
  DEBUG_QUEUE,
  EXECUTION_QUEUE,
  getLanguage,
  isTerminalStatus,
  redisKeys,
  utf8ByteLength,
  validateExecutionRequest,
  type ExecutionJob,
  type ExecutionResult,
} from "@cw/shared";
import { config } from "../config.js";
import { RunnerStatusService } from "../health/runner-status.service.js";
import { DEBUG_QUEUE_TOKEN, EXECUTION_QUEUE_TOKEN, PRISMA, REDIS, type ExecutionQueue } from "../infra/infra.module.js";
import { createRedis } from "../infra/redis.js";
import { ExecutionStore } from "./execution-store.js";
import { RateLimiter } from "./rate-limiter.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertExecutionId(id: string) {
  if (!UUID.test(id)) throw new BadRequestException("Invalid execution id.");
}

@Injectable()
export class ExecutionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionsService.name);
  private queueEvents: QueueEvents[] = [];

  constructor(
    @Inject(EXECUTION_QUEUE_TOKEN) private readonly queue: ExecutionQueue,
    @Inject(DEBUG_QUEUE_TOKEN) private readonly debugQueue: ExecutionQueue,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly store: ExecutionStore,
    private readonly limiter: RateLimiter,
    private readonly runners: RunnerStatusService,
  ) {}

  onModuleInit() {
    // Release rate-limit slots when jobs end, and report worker crashes to waiting clients.
    for (const name of [EXECUTION_QUEUE, DEBUG_QUEUE]) {
      const events = new QueueEvents(name, { connection: createRedis(`${name}-events`, { maxRetriesPerRequest: null }) });
      events.on("completed", ({ jobId }) => void this.release(jobId));
      events.on("failed", ({ jobId, failedReason }) => {
        this.logger.error(`execution ${jobId} failed in worker: ${failedReason}`);
        void this.onWorkerFailure(jobId);
      });
      // Connection errors are already reported by the Redis connection itself.
      events.on("error", () => {});
      this.queueEvents.push(events);
    }
  }

  async onModuleDestroy() {
    await Promise.all(this.queueEvents.map((e) => e.close()));
  }

  async create(body: unknown, client: string): Promise<{ id: string }> {
    const parsed = validateExecutionRequest(body);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    const request = parsed.value;
    const lang = getLanguage(request.language)!;

    const runner = await this.runners.get();
    if (!runner.available) throw new ServiceUnavailableException(runner.reason ?? "The execution service is not available.");
    if (!runner.readyLanguages.includes(lang.id)) {
      throw new ServiceUnavailableException(`The ${lang.name} sandbox is still being prepared. Try again in a minute.`);
    }

    const decision = await this.limiter.check(client);
    if (!decision.ok) {
      throw new HttpException(
        decision.reason === "rate"
          ? `Too many runs. You can start ${config.rateLimit.perMinute} per minute; try again in ${decision.retryAfterSeconds}s.`
          : `You already have ${config.rateLimit.concurrent} runs in progress. Wait for one to finish.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const queue = request.mode === "debug" ? this.debugQueue : this.queue;
    const depth = await queue.getWaitingCount();
    if (depth >= config.rateLimit.maxQueueDepth) {
      throw new ServiceUnavailableException("The execution service is at capacity. Try again shortly.");
    }

    const id = randomUUID();
    await this.prisma.execution.create({
      data: {
        id,
        language: lang.id,
        entryFile: request.entry,
        fileCount: request.files.length,
        sourceBytes: request.files.reduce((n, f) => n + utf8ByteLength(f.content), 0),
        runtimeVersion: lang.version,
        clientHash: client,
      },
    });
    await this.redis.set(`exec:${id}:client`, client, "EX", 3600);
    await this.limiter.markActive(client, id);
    await this.store.appendEvent({ type: "status", executionId: id, status: "QUEUED" });

    const job: ExecutionJob = { executionId: id, request, enqueuedAt: Date.now() };
    // One attempt only: user code must never be silently re-run.
    await queue.add(request.mode === "debug" ? "debug" : "run", job, { jobId: id, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
    return { id };
  }

  async get(id: string): Promise<ExecutionResult> {
    assertExecutionId(id);
    const result = await this.store.getResult(id);
    if (!result) throw new NotFoundException("Execution not found.");
    return result;
  }

  async cancel(id: string): Promise<{ ok: true }> {
    assertExecutionId(id);
    const result = await this.store.getResult(id);
    if (!result) throw new NotFoundException("Execution not found.");
    if (isTerminalStatus(result.status)) return { ok: true };

    await this.redis.set(redisKeys.cancel(id), "1", "EX", 3600);
    // If it has not started, remove it from the queue and finish it here.
    const job = (await this.queue.getJob(id)) ?? (await this.debugQueue.getJob(id));
    if (job && (await job.isWaiting())) {
      try {
        await job.remove();
        await this.store.finalize(id, result.language, "CANCELLED", "Stopped before it started.");
        await this.release(id);
      } catch {
        // A worker picked it up in the meantime; it will see the cancel flag.
      }
    }
    return { ok: true };
  }

  /** Forwards a debug command to the worker running the session. Returns an error message or null. */
  async sendDebugCommand(id: string, requestId: string, command: unknown): Promise<string | null> {
    const result = await this.store.getResult(id);
    if (!result) return "Execution not found.";
    if (isTerminalStatus(result.status)) return "The debug session has ended.";
    await this.store.appendCommand(id, { requestId, command });
    return null;
  }

  private async release(executionId: string) {
    const client = await this.redis.get(`exec:${executionId}:client`);
    if (client) await this.limiter.markDone(client, executionId);
  }

  private async onWorkerFailure(executionId: string) {
    const row = await this.prisma.execution.findUnique({ where: { id: executionId }, select: { language: true } }).catch(() => null);
    if (row) {
      await this.store.finalize(executionId, row.language, "SYSTEM_ERROR", "The execution worker stopped unexpectedly. Please retry.");
    }
    await this.release(executionId);
  }
}
