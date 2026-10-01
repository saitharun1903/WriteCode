import { describe, expect, it } from "vitest";
import type { InterviewEvent } from "@cw/shared";
import { buildReport, describeEvent, summarize } from "./report";
import { parseStatement } from "./Statement";
import { measuredGrowth, type HiddenResult } from "./store";

const result = (input: string, ms: number): HiddenResult => ({
  test: { id: input.slice(0, 8), input, expected: "" },
  comparison: { verdict: "ran" },
  run: { index: 0, status: "SUCCESS", stdout: "", stderr: "", executionTime: ms },
});

describe("measured growth", () => {
  it("recognises linear and quadratic growth from test timings", () => {
    const sizes = [1_000, 10_000, 100_000];
    const linear = measuredGrowth(sizes.map((n) => result("x".repeat(n), 100 + n / 100)));
    expect(linear.label).toBe("O(n)");
    const quadratic = measuredGrowth(sizes.map((n) => result("x".repeat(n), 100 + (n / 1000) ** 2 / 2)));
    expect(quadratic.label).toBe("O(n²)");
  });

  it("does not guess from too little data or tiny timings", () => {
    expect(measuredGrowth([result("1", 50), result("22", 51)]).label).toBeUndefined();
    // Sizes too close together.
    expect(measuredGrowth([result("x".repeat(100), 60), result("x".repeat(200), 90), result("x".repeat(300), 120)]).label).toBeUndefined();
    // Everything within start-up noise.
    expect(measuredGrowth([result("x".repeat(10), 80), result("x".repeat(1000), 81), result("x".repeat(100000), 82)]).label).toBeUndefined();
  });
});

describe("activity summary and report", () => {
  const events: InterviewEvent[] = [
    { t: 1, kind: "tab-hidden", who: "Asha" },
    { t: 2, kind: "tab-visible", who: "Asha", awayMs: 12_000 },
    { t: 3, kind: "paste", who: "Asha", chars: 120, detail: "for (int i = 0; ...) <script>" },
    { t: 4, kind: "fullscreen-exit", who: "Asha" },
    { t: 5, kind: "run", who: "Asha" },
    { t: 6, kind: "submit", who: "Asha", detail: "Wrong answer: 2 / 3 tests passed" },
    { t: 7, kind: "submit", detail: "Accepted: 3 / 3 tests passed" },
  ];

  it("counts what the interviewer should look at", () => {
    expect(summarize(events)).toMatchObject({ tabSwitches: 1, awayMs: 12_000, pastes: 1, pastedChars: 120, largePastes: 1, fullscreenExits: 1, runs: 1, submissions: 2 });
    expect(describeEvent(events[2]!)).toBe("Asha tried to paste 120 characters (blocked)");
    expect(describeEvent(events[5]!)).toBe("Asha submitted. Wrong answer: 2 / 3 tests passed");
    expect(describeEvent(events[6]!)).toBe("The code handed in was checked. Accepted: 3 / 3 tests passed");
  });

  it("builds a self-contained report with the candidate's text escaped", () => {
    const html = buildReport({
      interview: {
        title: "Two <sum>",
        statement: "",
        durationMin: 30,
        startedAt: 0,
        endedAt: 60_000,
        endReason: "Asha left the interview window 3 times",
        candidate: "Asha",
        maxLeaves: 3,
        leaves: 3,
        verdicts: [{ at: 5, status: "wrong-answer", passed: 2, total: 3 }],
      },
      priv: { hiddenTests: [], notes: "Good", rating: 3, events },
      interviewer: "Meera",
      project: { id: "p", name: "x", language: "java", entryFile: "Main.java", files: [{ path: "Main.java", content: "class Main {}" }], folders: [], stdin: "", createdAt: 0, updatedAt: 0 },
      hidden: null,
    });
    expect(html).toContain("Two &lt;sum&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("★★★☆☆");
    expect(html).toContain("1 time(s)");
    expect(html).toContain("Wrong answer</span> · 2 / 3 tests passed");
    expect(html).toContain("Asha left the interview window 3 times");
    expect(html).toContain("3 time(s) (the interview ends at 3)");
  });
});

const STATEMENT = ["Read n and print 2n.", "", "Constraints:", "1 <= n <= 100", "", "Example 1", "Input:", "2", "Output:", "4", "", "Twice two is four.", "", "Example 2:", "Input: 5", "Output: 10"];

describe("the problem statement", () => {
  it("is laid out as paragraphs, headings and examples", () => {
    const blocks = parseStatement(STATEMENT.join(String.fromCharCode(10)));
    expect(blocks).toEqual([
      { kind: "text", text: "Read n and print 2n." },
      { kind: "heading", text: "Constraints" },
      { kind: "text", text: "1 <= n <= 100" },
      { kind: "example", title: "Example 1", rows: [{ label: "Input", text: "2" }, { label: "Output", text: "4" }], note: "Twice two is four." },
      { kind: "example", title: "Example 2", rows: [{ label: "Input", text: "5" }, { label: "Output", text: "10" }] },
    ]);
  });

  it("leaves ordinary text alone", () => {
    const plain = ["Print the sum.", "Input: two numbers."].join(String.fromCharCode(10));
    expect(parseStatement(plain)).toEqual([{ kind: "text", text: plain }]);
  });
});
