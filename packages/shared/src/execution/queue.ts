import type { ExecutionRequest } from "./types.js";

/**
 * Contract between the API and the execution worker. Both sides import these
 * names so queue and key layouts cannot drift apart.
 */
export const EXECUTION_QUEUE = "executions";
/** Debug sessions are long-lived, so they get their own queue and concurrency. */
export const DEBUG_QUEUE = "debug-sessions";

export interface ExecutionJob {
  executionId: string;
  request: ExecutionRequest;
  enqueuedAt: number;
}

/** How long streams and results stay in Redis after an execution finishes. */
export const EXECUTION_TTL_SECONDS = 60 * 60;

export const redisKeys = {
  /** Redis Stream of ExecutionStreamEvent JSON, replayable from the start. */
  events: (id: string) => `exec:${id}:events`,
  /** Final ExecutionResult JSON. */
  result: (id: string) => `exec:${id}:result`,
  /** Redis Stream of debug commands from clients to the worker holding the session. */
  commands: (id: string) => `exec:${id}:commands`,
  /** Set to request cancellation; the worker polls it. */
  cancel: (id: string) => `exec:${id}:cancel`,
  /** Worker heartbeat with sandbox readiness, refreshed every few seconds. */
  runnerHeartbeat: (workerId: string) => `runner:heartbeat:${workerId}`,
  runnerHeartbeatPattern: "runner:heartbeat:*",
  /** Per-client active execution set, used to cap concurrent runs. */
  activeByClient: (clientHash: string) => `client:${clientHash}:active`,
  /** Fixed-window rate limit counter. */
  rateWindow: (clientHash: string, window: number) => `client:${clientHash}:rate:${window}`,
} as const;

/** Field name used for the JSON payload in stream entries. */
export const STREAM_FIELD = "e";

export interface RunnerHeartbeat {
  workerId: string;
  dockerAvailable: boolean;
  /** Language ids whose images are present and runnable. */
  readyLanguages: string[];
  /** Human-readable reason when the runner is not fully ready. */
  reason?: string;
  runtime: string;
  concurrency: number;
  at: number;
}
