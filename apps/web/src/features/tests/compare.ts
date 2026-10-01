import { outputLines } from "@cw/shared";

// The judge itself is shared with the server, which checks interview submissions the same way.
export { compareOutput, judge, outputLines, type Comparison, type Verdict } from "@cw/shared";

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
