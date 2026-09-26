import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Execution, PrismaClient } from "@cw/db";
import {
  EXECUTION_TTL_SECONDS,
  STREAM_FIELD,
  getLanguage,
  redisKeys,
  type ExecutionResult,
  type ExecutionStreamEvent,
} from "@cw/shared";
import { PRISMA, REDIS } from "../infra/infra.module.js";

export function rowToResult(row: Execution): ExecutionResult {
  return {
    id: row.id,
    status: row.status,
    language: row.language,
    stdout: row.stdout,
    stderr: row.stderr,
    compileOutput: row.compileOutput,
    exitCode: row.exitCode ?? undefined,
    executionTime: row.executionTime ?? undefined,
    compileTime: row.compileTime ?? undefined,
    memoryUsed: row.memoryUsed !== null ? Number(row.memoryUsed) : undefined,
    runtimeVersion: row.runtimeVersion,
    message: row.message ?? undefined,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

/** Reads and finalizes execution state across Redis (live) and Postgres (durable). */
@Injectable()
export class ExecutionStore {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  async appendEvent(event: ExecutionStreamEvent): Promise<void> {
    const key = redisKeys.events(event.executionId);
    await this.redis.multi().xadd(key, "*", STREAM_FIELD, JSON.stringify(event)).expire(key, EXECUTION_TTL_SECONDS).exec();
  }

  async hasEvents(id: string): Promise<boolean> {
    return (await this.redis.exists(redisKeys.events(id))) === 1;
  }

  /** Latest known result: live Redis copy first, then the durable row. */
  async getResult(id: string): Promise<ExecutionResult | null> {
    const cached = await this.redis.get(redisKeys.result(id)).catch(() => null);
    if (cached) return JSON.parse(cached) as ExecutionResult;
    const row = await this.prisma.execution.findUnique({ where: { id } });
    return row ? rowToResult(row) : null;
  }

  /**
   * Ends an execution from the API side (cancelled while queued, or its worker
   * died). A no-op when a result already exists, so it never overwrites the worker.
   */
  async finalize(id: string, language: string, status: ExecutionResult["status"], message: string): Promise<void> {
    const existing = await this.redis.exists(redisKeys.result(id));
    if (existing) return;
    const now = new Date().toISOString();
    const result: ExecutionResult = {
      id,
      status,
      language,
      stdout: "",
      stderr: "",
      compileOutput: "",
      runtimeVersion: getLanguage(language)?.version ?? "",
      message,
      createdAt: now,
      finishedAt: now,
    };
    // NX guards against a race with a worker finishing at the same moment.
    const set = await this.redis.set(redisKeys.result(id), JSON.stringify(result), "EX", EXECUTION_TTL_SECONDS, "NX");
    if (set !== "OK") return;
    await this.appendEvent({ type: "result", executionId: id, result });
    await this.prisma.execution
      .update({ where: { id }, data: { status, message, finishedAt: new Date() } })
      .catch(() => {});
  }
}
