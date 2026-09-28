import type { ExecutionStatus } from "@cw/shared";

/**
 * How test output is checked, like an online judge: line by line, ignoring
 * spaces at the end of a line, blank lines at the end, and Windows line endings.
 * Everything else, including spaces inside a line and letter case, must match.
 */
export function outputLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export type Verdict = "passed" | "failed" | "ran" | "compile-error" | "time-limit" | "crashed" | "error";

export interface Comparison {
  verdict: Verdict;
  /** 0-based index of the first differing line, when the output was wrong. */
  firstDiff?: number;
}

export function compareOutput(expected: string, actual: string): { pass: boolean; firstDiff?: number } {
  const want = outputLines(expected);
  const got = outputLines(actual);
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) if (want[i] !== got[i]) return { pass: false, firstDiff: i };
  return { pass: true };
}

/** The verdict for one test: how the program ended first, then whether it printed the expected output. */
export function judge(status: ExecutionStatus, expected: string, stdout: string): Comparison {
  if (status === "TIME_LIMIT") return { verdict: "time-limit" };
  if (status === "RUNTIME_ERROR" || status === "MEMORY_LIMIT") return { verdict: "crashed" };
  if (status !== "SUCCESS" && status !== "OUTPUT_LIMIT") return { verdict: "error" };
  if (!expected.trim()) return { verdict: "ran" };
  const { pass, firstDiff } = compareOutput(expected, stdout);
  return pass ? { verdict: "passed" } : { verdict: "failed", firstDiff };
}

export interface DiffRow {
  line: number;
  expected: string | null;
  actual: string | null;
  same: boolean;
}

/** Expected and actual output side by side, line by line (the way judges compare them). */
export function diffRows(expected: string, actual: string): DiffRow[] {
  const want = outputLines(expected);
  const got = outputLines(actual);
  return Array.from({ length: Math.max(want.length, got.length) }, (_, i) => ({
    line: i + 1,
    expected: want[i] ?? null,
    actual: got[i] ?? null,
    same: want[i] === got[i],
  }));
}

/** Where two lines first differ, for highlighting the exact character. */
export function firstCharDiff(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
