import type { ExecutionStatus } from "@cw/shared";

export interface StepOutcome {
  exitCode: number | null;
  /** The worker killed the sandbox because the wall-clock limit passed. */
  timedOut: boolean;
  /** The worker killed the sandbox because output exceeded the cap. */
  outputLimited: boolean;
  cancelled: boolean;
  /** Docker reported the container's cgroup hit its memory limit. */
  oomKilled: boolean;
}

/** SIGKILL exit status. Seen when the kernel OOM killer ends the program. */
const SIGKILL_EXIT = 137;

/** Maps a finished run step to a user-facing status. Order matters: our own kills win. */
export function classifyRun(o: StepOutcome): ExecutionStatus {
  if (o.cancelled) return "CANCELLED";
  if (o.timedOut) return "TIME_LIMIT";
  if (o.outputLimited) return "OUTPUT_LIMIT";
  if (o.oomKilled || o.exitCode === SIGKILL_EXIT) return "MEMORY_LIMIT";
  if (o.exitCode === 0) return "SUCCESS";
  if (o.exitCode === null) return "SYSTEM_ERROR";
  return "RUNTIME_ERROR";
}

/** Maps a finished compile step. Returns null when compilation succeeded. */
export function classifyCompile(o: StepOutcome): { status: ExecutionStatus; message?: string } | null {
  if (o.cancelled) return { status: "CANCELLED" };
  if (o.timedOut) return { status: "COMPILATION_ERROR", message: "Compilation took too long and was stopped." };
  if (o.outputLimited) return { status: "COMPILATION_ERROR", message: "The compiler produced too much output." };
  if (o.oomKilled || o.exitCode === SIGKILL_EXIT) return { status: "COMPILATION_ERROR", message: "The compiler ran out of memory." };
  if (o.exitCode === 0) return null;
  if (o.exitCode === null) return { status: "SYSTEM_ERROR", message: "The compiler did not report an exit status." };
  return { status: "COMPILATION_ERROR" };
}

/** Human explanation for statuses whose cause is not obvious from output alone. */
export function messageFor(status: ExecutionStatus, limits: { timeoutMs: number; memoryMb: number; maxOutputBytes: number }): string | undefined {
  switch (status) {
    case "TIME_LIMIT":
      return `Stopped after ${limits.timeoutMs / 1000}s wall-clock time. Check for infinite loops or input the program is waiting for (use the Input tab).`;
    case "MEMORY_LIMIT":
      return `Killed after exceeding the ${limits.memoryMb} MB memory limit.`;
    case "OUTPUT_LIMIT":
      return `Stopped after printing more than ${Math.round(limits.maxOutputBytes / 1000)} KB of output.`;
    default:
      return undefined;
  }
}
