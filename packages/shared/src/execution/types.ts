export const EXECUTION_STATUSES = [
  "QUEUED",
  "COMPILING",
  "RUNNING",
  "SUCCESS",
  "COMPILATION_ERROR",
  "RUNTIME_ERROR",
  "TIME_LIMIT",
  "MEMORY_LIMIT",
  "OUTPUT_LIMIT",
  "CANCELLED",
  "SYSTEM_ERROR",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  "SUCCESS",
  "COMPILATION_ERROR",
  "RUNTIME_ERROR",
  "TIME_LIMIT",
  "MEMORY_LIMIT",
  "OUTPUT_LIMIT",
  "CANCELLED",
  "SYSTEM_ERROR",
]);

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface ExecutionRequest {
  language: string;
  files: SourceFile[];
  /** Path of the entry file within `files`. */
  entry: string;
  stdin?: string;
}

export interface ExecutionLimits {
  /** Wall-clock limit for the run phase, in milliseconds. */
  timeoutMs: number;
  /** Wall-clock limit for the compile phase, in milliseconds. */
  compileTimeoutMs: number;
  memoryMb: number;
  cpus: number;
  pids: number;
  /** Combined stdout + stderr cap, in bytes. */
  maxOutputBytes: number;
}

export interface ExecutionResult {
  id: string;
  status: ExecutionStatus;
  language: string;
  stdout: string;
  stderr: string;
  /** Compiler output, kept separate from program stderr. */
  compileOutput: string;
  exitCode?: number;
  /** Run-phase wall time in milliseconds. */
  executionTime?: number;
  compileTime?: number;
  /** Peak memory of the sandbox in bytes, when the runtime can report it. */
  memoryUsed?: number;
  runtimeVersion: string;
  /** Short, user-facing explanation for non-success states. */
  message?: string;
  createdAt: string;
  finishedAt?: string;
}

/** Events streamed to the browser while an execution is in flight. */
export type ExecutionStreamEvent =
  | { type: "status"; executionId: string; status: ExecutionStatus }
  | { type: "stdout"; executionId: string; chunk: string }
  | { type: "stderr"; executionId: string; chunk: string }
  | { type: "compile"; executionId: string; chunk: string }
  | { type: "result"; executionId: string; result: ExecutionResult };

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: 10_000,
  compileTimeoutMs: 30_000,
  memoryMb: 256,
  cpus: 1,
  pids: 64,
  maxOutputBytes: 1_000_000,
};

/** Validation bounds for incoming requests. Enforced by the API. */
export const REQUEST_BOUNDS = {
  maxFiles: 50,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxStdinBytes: 256 * 1024,
  maxPathLength: 200,
} as const;
