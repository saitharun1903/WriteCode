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

const SIGNALS: Record<number, string> = {
  4: "SIGILL (illegal instruction)",
  6: "SIGABRT (abort, e.g. a failed assertion or std::terminate)",
  7: "SIGBUS (bus error)",
  8: "SIGFPE (arithmetic error, e.g. integer division by zero)",
  9: "SIGKILL",
  11: "SIGSEGV (segmentation fault: invalid memory access)",
  13: "SIGPIPE (broken pipe)",
  24: "SIGXCPU (CPU time limit)",
  25: "SIGXFSZ (file size limit)",
};

/** Sandbox policies a failing program commonly runs into, recognised from its real error output. */
const POLICY_HINTS: { pattern: RegExp; hint: string }[] = [
  {
    pattern: /Network is unreachable|Temporary failure in name resolution|Name or service not known|EAI_AGAIN|ENETUNREACH|UnknownHostException|getaddrinfo/,
    hint: "Network access is disabled in the sandbox.",
  },
  { pattern: /Read-only file system|EROFS/, hint: "Only the project folder and /tmp are writable in the sandbox." },
  {
    pattern: /Resource temporarily unavailable|unable to create native thread|BlockingIOError: \[Errno 11\]|fork: retry|EAGAIN/,
    hint: "The program reached the sandbox's process and thread limit.",
  },
  { pattern: /File too large|EFBIG/, hint: "Files written by the program are limited to 16 MB." },
  { pattern: /No space left on device|ENOSPC/, hint: "The sandbox's writable space (64 MB) is full." },
  { pattern: /OutOfMemoryError: Java heap space/, hint: "The JVM ran out of heap memory." },
];

/**
 * Explains a failed run from its exit status and real stderr: which signal
 * ended it, or which sandbox policy it ran into. Never replaces the output.
 */
export function explainRuntimeError(exitCode: number | null | undefined, stderr: string): string | undefined {
  const parts: string[] = [];
  if (exitCode !== null && exitCode !== undefined && exitCode > 128 && exitCode !== 137) {
    const sig = exitCode - 128;
    parts.push(`Terminated by signal ${sig}${SIGNALS[sig] ? `: ${SIGNALS[sig]}` : ""}.`);
  }
  const tail = stderr.slice(-8000);
  for (const { pattern, hint } of POLICY_HINTS) {
    if (pattern.test(tail)) {
      parts.push(hint);
      break;
    }
  }
  return parts.length ? parts.join(" ") : undefined;
}

/** Message for a run stopped by a time limit, by which limit fired. */
export function timeLimitMessage(limit: "run" | "input" | "wall" | undefined, limits: { timeoutMs: number }, caps?: { maxInputWaitMs: number; maxWallMs: number }): string {
  if (limit === "input" && caps) return `Stopped after waiting ${caps.maxInputWaitMs / 60_000} minutes for input.`;
  if (limit === "wall" && caps) return `Interactive runs are limited to ${caps.maxWallMs / 60_000} minutes in total.`;
  return `Stopped after ${limits.timeoutMs / 1000}s of running time. Check for infinite loops${caps ? "" : ", or input the program is waiting for"}.`;
}
