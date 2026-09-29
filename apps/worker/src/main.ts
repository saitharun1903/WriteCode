import { writeFile } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createPrismaClient } from "@cw/db";
import { DEBUG_QUEUE, EXECUTION_QUEUE, redisKeys, type ExecutionJob, type ExecutionResult, type RunnerHeartbeat } from "@cw/shared";
import { config } from "./config.js";
import { createDocker, dockerAvailable, ensureImages, readyLanguages, sweepOrphans } from "./docker.js";
import { EventEmitter } from "./events.js";
import { createLogger } from "./logger.js";
import { runDebugSession } from "./debug/session.js";
import { runExecution } from "./runner.js";

const log = createLogger({ service: "worker", workerId: config.workerId });
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const docker = createDocker(config.dockerHost);
const prisma = createPrismaClient();

const HEARTBEAT_MS = 5_000;
let ready: string[] = [];
let dockerUp = false;
let preparing = true;

function truncate(s: string): { text: string; truncated: boolean } {
  return s.length > config.storedOutputChars ? { text: s.slice(0, config.storedOutputChars), truncated: true } : { text: s, truncated: false };
}

async function persistResult(result: ExecutionResult): Promise<void> {
  const stdout = truncate(result.stdout);
  const stderr = truncate(result.stderr);
  const compile = truncate(result.compileOutput);
  await prisma.execution.update({
    where: { id: result.id },
    data: {
      status: result.status,
      exitCode: result.exitCode ?? null,
      executionTime: result.executionTime ?? null,
      compileTime: result.compileTime ?? null,
      queueTime: result.queueTime ?? null,
      startupTime: result.startupTime ?? null,
      memoryUsed: result.memoryUsed !== undefined ? BigInt(result.memoryUsed) : null,
      message: result.message ?? null,
      stdout: stdout.text,
      stderr: stderr.text,
      compileOutput: compile.text,
      outputTruncated: stdout.truncated || stderr.truncated || compile.truncated,
      finishedAt: new Date(result.finishedAt ?? Date.now()),
    },
  });
}

/**
 * Keeps the database from growing without bound: program output is only needed while
 * the page may still ask for a result, and records are kept a month for abuse analysis.
 */
async function pruneRecords(): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const cleared = await prisma.execution.updateMany({
    where: { createdAt: { lt: new Date(Date.now() - day) }, OR: [{ stdout: { not: "" } }, { stderr: { not: "" } }, { compileOutput: { not: "" } }] },
    data: { stdout: "", stderr: "", compileOutput: "" },
  });
  const deleted = await prisma.execution.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * day) } } });
  if (cleared.count || deleted.count) log.info("pruned execution records", { outputsCleared: cleared.count, deleted: deleted.count });
}

async function heartbeat(): Promise<void> {
  dockerUp = await dockerAvailable(docker);
  if (dockerUp && !preparing) ready = await readyLanguages(docker);
  const reason = !dockerUp
    ? "Docker is not reachable from the worker. Start Docker Desktop (or the Docker daemon)."
    : preparing
      ? "Downloading sandbox images. The first start can take several minutes."
      : ready.length === 0
        ? "No sandbox images are available."
        : undefined;
  const beat: RunnerHeartbeat = {
    workerId: config.workerId,
    dockerAvailable: dockerUp,
    readyLanguages: dockerUp ? ready : [],
    reason,
    runtime: config.runtime ?? "runc",
    concurrency: config.concurrency,
    at: Date.now(),
  };
  await redis.set(redisKeys.runnerHeartbeat(config.workerId), JSON.stringify(beat), "PX", HEARTBEAT_MS * 3);
  // Healthy means Redis accepted the heartbeat and Docker answered.
  if (config.healthFile && dockerUp) await writeFile(config.healthFile, String(Date.now())).catch(() => {});
}

type JobSummary = Pick<ExecutionResult, "id" | "status">;

async function processJob(job: Job<ExecutionJob>): Promise<ExecutionResult> {
  const { executionId, request } = job.data;
  const jlog = log.child({ executionId, language: request.language });
  const events = new EventEmitter(redis, executionId);
  const isCancelled = async () => (await redis.exists(redisKeys.cancel(executionId))) === 1;

  const queueTime = Math.max(0, Date.now() - job.data.enqueuedAt);
  let result: ExecutionResult;
  if (await isCancelled()) {
    const lang = request.language;
    result = {
      id: executionId,
      status: "CANCELLED",
      language: lang,
      stdout: "",
      stderr: "",
      compileOutput: "",
      runtimeVersion: "",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: "Cancelled before it started.",
    };
  } else if (!ready.includes(request.language)) {
    result = {
      id: executionId,
      status: "SYSTEM_ERROR",
      language: request.language,
      stdout: "",
      stderr: "",
      compileOutput: "",
      runtimeVersion: "",
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: "The sandbox for this language is not ready yet. Try again shortly.",
    };
  } else {
    await prisma.execution.update({ where: { id: executionId }, data: { startedAt: new Date() } }).catch(() => {});
    jlog.info("execution started", { mode: request.mode ?? "run", interactive: request.interactive === true, queueTime });
    const common = {
      docker,
      executionId,
      request,
      limits: config.limits,
      runtime: config.runtime,
      workspaceMb: config.workspaceMb,
      maxFileSizeBytes: config.maxFileSizeBytes,
      events,
      isCancelled,
      log: (msg: string, extra?: Record<string, unknown>) => jlog.error(msg, extra),
    };
    if (request.mode === "debug" || request.interactive) {
      // The command/input reader blocks, so each session gets its own connection.
      const commandRedis = redis.duplicate();
      try {
        result = request.mode === "debug" ? await runDebugSession({ ...common, commandRedis }) : await runExecution({ ...common, commandRedis });
      } finally {
        commandRedis.disconnect();
      }
    } else {
      result = await runExecution(common);
    }
  }
  result = { ...result, queueTime };

  await events.result(result);
  await persistResult(result).catch((e) => jlog.error("failed to persist result", { error: String(e) }));
  // One structured line per execution. Contains no source code or program output.
  jlog.info("execution finished", {
    mode: request.mode ?? "run",
    interactive: request.interactive === true,
    runtime: request.language,
    runtimeVersion: result.runtimeVersion,
    sandboxRuntime: config.runtime ?? "runc",
    fileCount: request.files.length,
    status: result.status,
    terminationReason: result.message ?? null,
    exitCode: result.exitCode ?? null,
    queueTime,
    startupTime: result.startupTime ?? null,
    compileTime: result.compileTime ?? null,
    executionTime: result.executionTime ?? null,
    memoryPeakBytes: result.memoryUsed ?? null,
  });
  return result;
}

async function main() {
  log.info("starting worker", { concurrency: config.concurrency, runtime: config.runtime ?? "runc" });

  await heartbeat().catch((e) => log.error("heartbeat failed", { error: String(e) }));
  const beatTimer = setInterval(() => void heartbeat().catch((e) => log.error("heartbeat failed", { error: String(e) })), HEARTBEAT_MS);
  const prune = () => void pruneRecords().catch((e) => log.warn("pruning records failed", { error: String(e) }));
  prune();
  const pruneTimer = setInterval(prune, 60 * 60 * 1000);

  if (await dockerAvailable(docker)) {
    await sweepOrphans(docker, log).catch((e) => log.warn("orphan sweep failed", { error: String(e) }));
    ready = await readyLanguages(docker);
    // Languages with images present can run while missing images download.
    void ensureImages(docker, log, () => void readyLanguages(docker).then((r) => (ready = r)))
      .finally(() => {
        preparing = false;
        void heartbeat();
      });
  } else {
    log.error("Docker is not reachable; executions will fail until it is running");
    preparing = false;
  }

  // BullMQ keeps each job's return value in Redis; the result itself is already stored, so keep only a summary.
  const processAndSummarize = async (job: Job<ExecutionJob>): Promise<JobSummary> => {
    const result = await processJob(job);
    return { id: result.id, status: result.status };
  };
  const worker = new Worker<ExecutionJob, JobSummary>(EXECUTION_QUEUE, processAndSummarize, {
    connection: redis,
    concurrency: config.concurrency,
    // Never re-run user code automatically after a crash.
    maxStalledCount: 0,
  });
  const debugWorker = new Worker<ExecutionJob, JobSummary>(DEBUG_QUEUE, processAndSummarize, {
    connection: redis,
    concurrency: Math.max(config.debugConcurrency, 1),
    maxStalledCount: 0,
    autorun: config.debugConcurrency > 0,
    // Sessions last minutes; keep the job lock alive well past the default 30s.
    lockDuration: 60_000,
  });
  for (const w of [worker, debugWorker]) {
    w.on("failed", (job, err) => log.error("job failed", { executionId: job?.data.executionId, error: err.message }));
    w.on("error", (err) => log.error("worker error", { error: err.message }));
  }

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    clearInterval(beatTimer);
    clearInterval(pruneTimer);
    await Promise.all([worker.close(), debugWorker.close()]);
    await redis.del(redisKeys.runnerHeartbeat(config.workerId)).catch(() => {});
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("worker crashed", { error: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
