import { describe, expect, it } from "vitest";
import { compareOutput, diffRows, firstCharDiff, judge, outputLines } from "./compare";

describe("comparing output", () => {
  it("ignores trailing spaces, trailing blank lines and CRLF, nothing else", () => {
    expect(outputLines("1 2 \r\n3\n\n\n")).toEqual(["1 2", "3"]);
    expect(compareOutput("1 2\n3\n", "1 2   \r\n3")).toEqual({ pass: true });
    expect(compareOutput("1 2\n3\n", "1  2\n3\n")).toEqual({ pass: false, firstDiff: 0 });
    expect(compareOutput("Yes\n", "yes\n")).toEqual({ pass: false, firstDiff: 0 });
    expect(compareOutput("a\nb\n", "a\n")).toEqual({ pass: false, firstDiff: 1 });
    expect(compareOutput("a\n", "a\n\nb")).toEqual({ pass: false, firstDiff: 1 });
  });

  it("judges how the program ended before its output", () => {
    expect(judge("SUCCESS", "5\n", "5\n").verdict).toBe("passed");
    expect(judge("SUCCESS", "5\n", "6\n")).toEqual({ verdict: "failed", firstDiff: 0 });
    expect(judge("SUCCESS", "  \n", "anything").verdict).toBe("ran");
    expect(judge("TIME_LIMIT", "5", "5").verdict).toBe("time-limit");
    expect(judge("RUNTIME_ERROR", "5", "5").verdict).toBe("crashed");
    expect(judge("MEMORY_LIMIT", "5", "").verdict).toBe("crashed");
    expect(judge("SYSTEM_ERROR", "5", "").verdict).toBe("error");
  });

  it("lines up expected and actual output row by row", () => {
    expect(diffRows("a\nb\n", "a\nc\nd\n")).toEqual([
      { line: 1, expected: "a", actual: "a", same: true },
      { line: 2, expected: "b", actual: "c", same: false },
      { line: 3, expected: null, actual: "d", same: false },
    ]);
    expect(firstCharDiff("answer 42", "answer 43")).toBe(8);
  });
});
