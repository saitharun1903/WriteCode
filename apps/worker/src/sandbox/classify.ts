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
  const policy = POLICY_HINTS.find(({ pattern }) => pattern.test(tail));
  if (policy) parts.push(policy.hint);
  else {
    const plain = explainException(tail);
    if (plain) parts.push(plain);
  }
  return parts.length ? parts.join(" ") : undefined;
}

const NULL_ACTIONS: [RegExp, (what: string) => string][] = [
  [/^invoke "(?:[\w.$]+\.)?([\w$]+)\(/, (m) => `so ${m}() can't be called on it`],
  [/^read field "([\w$]+)"/, (f) => `so its field ${f} can't be read`],
  [/^assign field "([\w$]+)"/, (f) => `so its field ${f} can't be set`],
  [/^(?:load from|store to) [\w$]+ array/, () => "so it has no elements to use"],
  [/^read the array length/, () => "so it has no length"],
];

/** The variable named in a Java "helpful NullPointerException" message, when it is a real name. */
function nullName(message: string): string | null {
  const name = /because "([^"]+)" is null/.exec(message)?.[1];
  return name && !name.startsWith("<") ? name.replace(/^this\./, "") : null;
}

/**
 * Plain-language explanations of the uncaught exceptions beginners meet most,
 * worked out from the exception's own message. Returns undefined for anything
 * it does not recognise, rather than guessing.
 */
const EXCEPTIONS: [RegExp, (m: RegExpExecArray) => string][] = [
  // Java
  [
    /ArrayIndexOutOfBoundsException: Index (-?\d+) out of bounds for length (\d+)/,
    (m) => `Index ${m[1]} is outside the array. Its length is ${m[2]}, so valid indexes are ${Number(m[2]) > 0 ? `0 to ${Number(m[2]) - 1}` : "none (it is empty)"}.`,
  ],
  [
    /StringIndexOutOfBoundsException: (?:Index|index|begin|end) (-?\d+).*?length (\d+)/,
    (m) => `Position ${m[1]} is outside the string. Its length is ${m[2]}, so valid positions are ${Number(m[2]) > 0 ? `0 to ${Number(m[2]) - 1}` : "none (it is empty)"}.`,
  ],
  [
    /IndexOutOfBoundsException: Index (-?\d+) out of bounds for length (\d+)/,
    (m) => `Index ${m[1]} is outside the list. Its size is ${m[2]}, so valid indexes are ${Number(m[2]) > 0 ? `0 to ${Number(m[2]) - 1}` : "none (it is empty)"}.`,
  ],
  [
    /NullPointerException(?:: Cannot (.+))?/,
    (m) => {
      const name = m[1] ? nullName(m[1]) : null;
      if (!name) return "Something used here is null: a variable or field was never given an object.";
      const action = NULL_ACTIONS.map(([re, say]) => {
        const x = re.exec(m[1]!);
        return x ? say(x[1] ?? "") : null;
      }).find(Boolean);
      return `${name} is null at this point${action ? `, ${action}` : ""}.`;
    },
  ],
  [/ArithmeticException: \/ by zero/, () => "Integer division by zero."],
  [/NumberFormatException: For input string: "([^"]*)"/, (m) => `"${m[1]}" is not a number, so it can't be converted.`],
  [/InputMismatchException/, () => "The input didn't match what the program tried to read, for example a word where nextInt() expected a number."],
  [/NoSuchElementException(?:: No line found)?/, () => "The program tried to read more input than it was given. Add it in Program Input, or type it while the program runs."],
  [/StackOverflowError/, () => "The recursion never stopped: check that every recursive call gets closer to the base case."],
  [/ClassCastException: class ([\w.$]+) cannot be cast to class ([\w.$]+)/, (m) => `A ${short(m[1]!)} can't be used as a ${short(m[2]!)}.`],
  [/ConcurrentModificationException/, () => "The collection was changed while a for-each loop was going through it. Use an Iterator's remove(), or loop over a copy."],
  // Python
  [/IndexError: (list|string|tuple) index out of range/, (m) => `An index is past the end of the ${m[1] === "string" ? "string" : m[1]}. Valid indexes go from 0 to its length minus 1.`],
  [/ZeroDivisionError/, () => "Division by zero."],
  [/ValueError: invalid literal for int\(\) with base 10: '([^']*)'/, (m) => `'${m[1]}' is not a whole number, so int() can't convert it.`],
  [/ValueError: could not convert string to float: '([^']*)'/, (m) => `'${m[1]}' is not a number, so float() can't convert it.`],
  [/EOFError: EOF when reading a line/, () => "input() was called but there was no more input. Add it in Program Input, or type it while the program runs."],
  [/RecursionError/, () => "The recursion never stopped: check that every recursive call gets closer to the base case."],
  [/NameError: name '([^']+)' is not defined/, (m) => `${m[1]} is used before it is defined. Check the spelling, or define it first.`],
  [/KeyError: (.+)$/m, (m) => `The key ${m[1]!.trim()} is not in the dictionary. Use in to check first, or .get().`],
  [/TypeError: 'NoneType' object is not (subscriptable|iterable|callable)/, () => "A value here is None: often a function that returns nothing, or a variable that was never set."],
  [/AttributeError: 'NoneType' object has no attribute '([^']+)'/, (m) => `A value here is None, so it has no .${m[1]}: often a function that returns nothing, or a variable that was never set.`],
  [/UnboundLocalError: (?:cannot access )?local variable '([^']+)'/, (m) => `${m[1]} is assigned inside the function, so Python treats it as local there, but it is used before that assignment.`],
];

function short(type: string): string {
  const name = type.slice(type.lastIndexOf(".") + 1);
  return name.slice(name.lastIndexOf("$") + 1) || name;
}

/** Plain explanation of the uncaught exception at the end of `stderr`, if it is a common one. */
export function explainException(stderr: string): string | undefined {
  // Java prints the uncaught exception first ("Exception in thread ..."); Python prints it last.
  const lines = stderr.trimEnd().split("\n");
  const javaHeader = lines.find((l) => /^Exception in thread /.test(l));
  const header = javaHeader ?? [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(l)) ?? "";
  for (const [pattern, explain] of EXCEPTIONS) {
    const m = pattern.exec(header);
    if (m) return explain(m);
  }
  return undefined;
}

/** Message for a run stopped by a time limit, by which limit fired. */
export function timeLimitMessage(limit: "run" | "input" | "wall" | undefined, limits: { timeoutMs: number }, caps?: { maxInputWaitMs: number; maxWallMs: number }): string {
  if (limit === "input" && caps) return `Stopped after waiting ${caps.maxInputWaitMs / 60_000} minutes for input.`;
  if (limit === "wall" && caps) return `Interactive runs are limited to ${caps.maxWallMs / 60_000} minutes in total.`;
  return `Stopped after ${limits.timeoutMs / 1000}s of running time. Check for infinite loops${caps ? "" : ", or input the program is waiting for"}.`;
}
