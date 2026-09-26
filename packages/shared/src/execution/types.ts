import type { DebugEvent } from "../debug/types.js";

export const EXECUTION_STATUSES = [
  "QUEUED",
  /** A worker picked the job up and is creating the sandbox. */
  "STARTING",
  "COMPILING",
  "RUNNING",
  /** Running, and the kernel reports the program blocked reading its stdin. */
  "WAITING_FOR_INPUT",
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

export type ExecutionMode = "run" | "debug";

export interface ExecutionRequest {
  language: string;
  files: SourceFile[];
  /** Path of the entry file within `files`. */
  entry: string;
  stdin?: string;
  /**
   * Keep the program's stdin open and stream input typed while it runs
   * (sent over the event socket). When false, `stdin` is the whole input and
   * the program sees end-of-file after it.
   */
  interactive?: boolean;
  /** Defaults to "run". "debug" starts an interactive debug session. */
  mode?: ExecutionMode;
  /** Debug mode only: project file -> 1-based breakpoint lines. */
  breakpoints?: Record<string, number[]>;
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
  /** Run-phase wall time in milliseconds, excluding time spent waiting for typed input. */
  executionTime?: number;
  compileTime?: number;
  /** Time between submission and a worker starting the job, in milliseconds. */
  queueTime?: number;
  /** Sandbox container creation and file setup, in milliseconds. */
  startupTime?: number;
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
  /** Echo of input the user typed into a running program. */
  | { type: "stdin"; executionId: string; chunk: string }
  | { type: "result"; executionId: string; result: ExecutionResult }
  | { type: "debug"; executionId: string; event: DebugEvent };

/** Interactive runs: typed-input waits do not count toward `timeoutMs`, within these caps. */
export const INTERACTIVE_LIMITS = {
  /** Longest a program may wait for one piece of input. */
  maxInputWaitMs: 5 * 60_000,
  /** Longest an interactive run may last in total. */
  maxWallMs: 15 * 60_000,
} as const;

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: 10_000,
  compileTimeoutMs: 30_000,
  memoryMb: 256,
  cpus: 1,
  // Counts threads too; a JVM on one CPU uses roughly 20.
  pids: 128,
  maxOutputBytes: 1_000_000,
};

/** Validation bounds for incoming requests. Enforced by the API. */
export const REQUEST_BOUNDS = {
  maxFiles: 50,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxStdinBytes: 256 * 1024,
  /** Largest single piece of typed input sent while a program runs. */
  maxInputChunkBytes: 2048,
  maxPathLength: 200,
} as const;
