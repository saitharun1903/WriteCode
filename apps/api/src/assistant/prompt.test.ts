import { describe, expect, it } from "vitest";
import { ASSISTANT_LIMITS, validateAssistantRequest, type AssistantRequest } from "@cw/shared";
import { buildPrompt, clipMiddle, numbered } from "./prompt.js";

const request = (over: Partial<AssistantRequest["context"]> = {}): AssistantRequest => ({
  messages: [{ role: "user", text: "Why does this crash?" }],
  context: { language: "python", files: [{ path: "main.py", content: "xs = []\nprint(sum(xs) / len(xs))\n" }], activeFile: "main.py", ...over },
});

describe("prompt", () => {
  it("numbers source lines so answers can cite them", () => {
    expect(numbered("a\nb\n")).toBe("1 | a\n2 | b");
    expect(numbered(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n")).split("\n")[0]).toBe(" 1 | l0");
  });

  it("keeps the start and end of long output", () => {
    const out = clipMiddle("A".repeat(50) + "B".repeat(50), 40);
    expect(out.startsWith("A".repeat(14))).toBe(true);
    expect(out.endsWith("B".repeat(26))).toBe(true);
    expect(out).toContain("60 characters omitted");
  });

  it("gives the model the rules, the real environment and the user's context", () => {
    const p = buildPrompt(
      request({
        cursorLine: 2,
        lastRun: { mode: "run", status: "RUNTIME_ERROR", exitCode: 1, stdout: "", stderr: "ZeroDivisionError: division by zero", message: "The program raised an exception." },
      }),
    );
    const system = p.systemInstruction.parts.map((x) => x.text).join("\n");
    expect(system).toContain("silently verify");
    expect(system).toContain("<<<<<<< ORIGINAL");
    expect(system).toContain("Python 3.13");
    expect(system).toContain("256 MB");
    expect(system).toContain("File main.py (open in the editor, cursor on line 2)");
    expect(system).toContain("2 | print(sum(xs) / len(xs))");
    expect(system).toContain("RUNTIME_ERROR, exit code 1");
    expect(system).toContain("ZeroDivisionError: division by zero");
    expect(p.contents).toEqual([{ role: "user", parts: [{ text: "Why does this crash?" }] }]);
  });

  it("includes the recorded visualizer step", () => {
    const p = buildPrompt(
      request({
        visualizer: { step: 18, total: 62, file: "main.py", line: 10, event: "line", ranLine: 12, happened: ["Swapped arr[2] and arr[3]"], state: "bubble_sort: arr=[2, 5, 1, 9]", output: "" },
      }),
    );
    const system = p.systemInstruction.parts.map((x) => x.text).join("\n");
    expect(system).toContain("step 18 of 62");
    expect(system).toContain("Line 12 just ran. What it changed: Swapped arr[2] and arr[3].");
  });
});

describe("validateAssistantRequest", () => {
  it("accepts a normal request", () => {
    expect(validateAssistantRequest(request()).ok).toBe(true);
  });

  it("rejects malformed and oversized requests", () => {
    expect(validateAssistantRequest({}).ok).toBe(false);
    expect(validateAssistantRequest({ ...request(), messages: [{ role: "assistant", text: "hi" }] }).ok).toBe(false);
    expect(validateAssistantRequest({ ...request(), messages: [{ role: "system", text: "x" }] }).ok).toBe(false);
    expect(validateAssistantRequest({ ...request(), messages: [{ role: "user", text: "x".repeat(ASSISTANT_LIMITS.maxMessageChars + 1) }] }).ok).toBe(false);
    const huge = request({ files: [{ path: "a.py", content: "x".repeat(ASSISTANT_LIMITS.maxTotalChars) }] });
    expect(validateAssistantRequest(huge)).toEqual({ ok: false, error: expect.stringContaining("too large") });
    expect(validateAssistantRequest(request({ lastRun: { mode: "hack", status: "x", stdout: "", stderr: "" } as never })).ok).toBe(false);
  });
});
