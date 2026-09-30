import { describe, expect, it } from "vitest";
import type { InterviewEvent } from "@cw/shared";
import { buildReport, summarize } from "./report";
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
  ];

  it("counts what the interviewer should look at", () => {
    expect(summarize(events)).toMatchObject({ tabSwitches: 1, awayMs: 12_000, pastes: 1, pastedChars: 120, largePastes: 1, fullscreenExits: 1, runs: 1 });
  });

  it("builds a self-contained report with the candidate's text escaped", () => {
    const html = buildReport({
      interview: { title: "Two <sum>", statement: "", durationMin: 30, startedAt: 0, endedAt: 60_000, candidate: "Asha" },
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
  });
});
