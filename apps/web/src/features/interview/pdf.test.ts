import { describe, expect, it } from "vitest";
import type { InterviewEvent } from "@cw/shared";
import { Pdf, pdfSafe, textWidth, wrap } from "./pdf";
import { buildReport, buildReportPdf } from "./report";
import { countAt, firstChangedLine } from "./ReplayDialog";

const NL = String.fromCharCode(10);
const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

describe("the PDF writer", () => {
  it("keeps to what the standard fonts can show", () => {
    expect(pdfSafe("a → b ≤ c — “q” …")).toBe('a -> b <= c - "q" ...');
    expect(pdfSafe("café नम")).toBe("café ??");
    expect(pdfSafe(`a${String.fromCharCode(9)}b`)).toBe("a    b");
  });

  it("wraps prose at spaces, cuts words longer than a line, and keeps code indented", () => {
    const lines = wrap("the quick brown fox jumps over the lazy dog", "regular", 10, 80);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
    for (const l of lines) expect(textWidth(l, "regular", 10)).toBeLessThanOrEqual(80);
    expect(wrap("x".repeat(40), "mono", 10, 60).every((l) => l.length <= 10)).toBe(true);
    const code = wrap("        return a + b + c + d + e + f", "mono", 10, 150);
    expect(code.length).toBeGreaterThan(1);
    expect(code[1]!.startsWith("        ")).toBe(true);
    expect(wrap(`a${NL}${NL}b`, "regular", 10, 100)).toEqual(["a", "", "b"]);
  });

  it("writes a document whose cross-reference table points at every object", () => {
    const pdf = new Pdf();
    pdf.heading("Summary");
    pdf.row("Candidate", "Asha (final)");
    pdf.code(Array.from({ length: 200 }, (_, i) => `line ${i} \\ with (brackets)`).join(NL));
    const file = latin1(pdf.build("footer"));
    expect(file.startsWith("%PDF-1.4")).toBe(true);
    expect(file.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(file)![1]);
    expect(file.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...file.slice(xref).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => expect(file.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // 200 lines of code do not fit on one page.
    expect(Number(/\/Count (\d+)/.exec(file)![1])).toBeGreaterThan(1);
    expect(file).toContain("Page 1 of");
    // Every stream is exactly as long as it says.
    for (const m of file.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) expect(file.slice(m.index + m[0].length + Number(m[1]), m.index + m[0].length + Number(m[1]) + 9)).toBe("endstream");
    expect(file).toContain("(line 0 \\\\ with \\(brackets\\))");
  });
});

describe("the interview report as PDF and Word", () => {
  const events: InterviewEvent[] = [
    { t: 1_000, kind: "started", detail: "30 minutes" },
    { t: 9_000, kind: "paste", who: "Asha", chars: 30, detail: "print('copied')" },
    { t: 20_000, kind: "submit", who: "Asha", detail: "Accepted: 3 / 3 tests passed" },
  ];
  const input = {
    interview: { title: "Double it", statement: "Print 2n.", durationMin: 30, startedAt: 1_000, endedAt: 61_000, endReason: "Asha finished", candidate: "Asha", maxLeaves: 3, leaves: 1, verdicts: [{ at: 20_000, status: "accepted" as const, passed: 3, total: 3, timeMs: 41, memoryBytes: 12 * 1024 * 1024 }] },
    priv: { hiddenTests: [], notes: "Clear thinking.", rating: 4, events },
    interviewer: "Meera",
    project: { id: "p", name: "x", language: "python", entryFile: "main.py", files: [{ path: "main.py", content: "print(int(input()) * 2)" }], folders: [], stdin: "", createdAt: 0, updatedAt: 0 },
    hidden: null,
    complexity: { time: "O(1)", space: "O(1)", explanation: "One multiplication.", approach: "Arithmetic", suggested: "Arithmetic", keyIdea: "Multiply by two.", consider: "What if n does not fit in 64 bits?" },
  };

  it("the PDF has the result, the integrity signals, the analysis, the notes, the code and the timeline", () => {
    const file = latin1(buildReportPdf(input));
    for (const text of ["Double it", "Accepted", "3 of 3 tests passed", "Asha finished", "Left the window", "1 time\\(s\\) \\(the interview ends at 3\\)", "Paste attempts \\(blocked\\)", "Arithmetic", "What if n does not fit in 64 bits?", "Clear thinking.", "(print)", "(main.py)", "Tests passed", "INTERVIEW REPORT", "(WriteCode)", "writecode.in", "Page 1 of", "Asha submitted. Accepted: 3 / 3 tests passed", "12.0 MB", "4 out of 5"]) {
      expect(file).toContain(text);
    }
  });

  it("the page used for Word carries the analysis too", () => {
    const html = buildReport(input);
    expect(html).toContain("Arithmetic");
    expect(html).toContain("12.0 MB");
    expect(html).toContain("What if n does not fit in 64 bits?");
  });
});

describe("the replay's position", () => {
  it("counts the changes made by a point in time", () => {
    const times = [10, 20, 20, 35];
    expect([5, 10, 19, 20, 34, 35, 99].map((t) => countAt(times, t))).toEqual([0, 1, 1, 3, 3, 4, 4]);
    expect(countAt([], 5)).toBe(0);
  });

  it("finds the line being typed", () => {
    expect(firstChangedLine(`a${NL}b${NL}c`, `a${NL}B${NL}c`)).toBe(2);
    expect(firstChangedLine(`a${NL}b`, `a${NL}b${NL}c`)).toBe(3);
    expect(firstChangedLine(`a${NL}b${NL}c`, "a")).toBe(1);
    expect(firstChangedLine("same", "same")).toBeNull();
  });
});
