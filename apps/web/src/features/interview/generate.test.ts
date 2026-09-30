import { describe, expect, it } from "vitest";
import type { ExecutionResult } from "@cw/shared";
import { INVALID, checkSmall, withExamples } from "./generate";

const result = (outs: (string | null)[]): ExecutionResult =>
  ({
    status: "SUCCESS",
    tests: outs.map((stdout, index) => (stdout === null ? { index, status: "TIME_LIMIT", stdout: "", stderr: "" } : { index, status: "SUCCESS", stdout, stderr: "" })),
  }) as unknown as ExecutionResult;

describe("checking generated tests", () => {
  const inputs = ["1\n", "2\n", "3\n", "4\n", "5\n"].map((input) => ({ input, note: `n = ${input.trim()}` }));

  it("keeps answers both solutions agree on, and those the brute force was too slow for", () => {
    const solution = result(["NO\r\n", "YES\n", "YES  \n\n", "NO\n", `${INVALID} n too large\n`]);
    const brute = result(["NO\n", "YES\n", "NO\n", null, "YES\n"]);
    const c = checkSmall(inputs, solution, brute);
    expect(c.tests.map((t) => [t.input, t.expected, t.note])).toEqual([
      ["1\n", "NO\n", "n = 1"],
      ["2\n", "YES\n", "n = 2"],
      ["4\n", "NO\n", "n = 4"],
    ]);
    expect(c).toMatchObject({ disagreements: 1, compared: 3, invalid: 1 });
  });

  it("drops tests the reference solution failed or printed nothing for", () => {
    const c = checkSmall(inputs.slice(0, 2), result([null, "  \n"]), undefined);
    expect(c.tests).toEqual([]);
  });

  it("adds the verified samples to the statement as examples", () => {
    const s = withExamples("Print n.\n\nInput\nOne line.", [{ input: "3\n", expected: "3\n", note: "The simplest case." }]);
    expect(s).toBe("Print n.\n\nInput\nOne line.\n\nExample 1\nInput:\n3\nOutput:\n3\n\nThe simplest case.");
  });
});
