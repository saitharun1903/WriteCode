import { describe, expect, it } from "vitest";
import type { ExecutionResult, HistoryEntry } from "@cw/shared";
import { ago, changeBetween, changes, outputPreview, versions } from "./runs";

const NL = String.fromCharCode(10);
const text = (...lines: string[]) => lines.join(NL);

function run(id: string, at: number, content: string, result: Partial<ExecutionResult> = {}, projectId = "p"): HistoryEntry {
  return {
    id,
    projectId,
    projectName: "Java project",
    language: "java",
    entryFile: "Main.java",
    files: [{ path: "Main.java", content }],
    stdin: "",
    createdAt: at,
    result: { id, status: "SUCCESS", language: "java", stdout: "", stderr: "", compileOutput: "", runtimeVersion: "21", createdAt: "", ...result },
  };
}

describe("run history as versions of the code", () => {
  it("runs of the same code are one version, at the time of its latest run", () => {
    // Newest first, as the history is listed.
    const list = versions([run("d", 40, "v1"), run("c", 30, "v2"), run("b", 20, "v1"), run("a", 10, "v1")]);
    expect(list.map((v) => [v.entry.id, v.runs, v.firstRunAt, v.duplicates])).toEqual([
      ["d", 3, 10, ["b", "a"]],
      ["c", 1, 30, []],
    ]);
  });

  it("counts runs already merged when they were recorded", () => {
    const merged = { ...run("a", 50, "v1"), runs: 4, firstRunAt: 5 };
    expect(versions([merged, run("b", 20, "v1")]).map((v) => [v.runs, v.firstRunAt])).toEqual([[5, 5]]);
  });

  it("the same code in two projects is two versions", () => {
    expect(versions([run("a", 2, "v1"), run("b", 1, "v1", {}, "q")])).toHaveLength(2);
  });

  it("says what changed since the version before", () => {
    const list = versions([run("c", 30, text("a", "b2", "c", "d")), run("b", 20, text("a", "b", "c")), run("a", 10, text("a", "b"))]);
    const changed = changes(list);
    expect(changed.get("a")).toBe("first");
    expect(changed.get("b")).toEqual({ added: 1, removed: 0, files: ["Main.java"] });
    expect(changed.get("c")).toEqual({ added: 2, removed: 1, files: ["Main.java"] });
  });

  it("counts added and removed files", () => {
    expect(changeBetween([{ path: "A.java", content: text("x", "y") }], [{ path: "B.java", content: "z" }])).toEqual({ added: 1, removed: 2, files: ["B.java", "A.java"] });
    expect(changeBetween([{ path: "A.java", content: "x" }], [{ path: "A.java", content: "x" }])).toBeNull();
  });
});

describe("what a run did, in one line", () => {
  it("is the first line printed", () => {
    expect(outputPreview(run("a", 1, "", { stdout: text("", "1 -> 2 -> null", "done") }))).toEqual({ text: "1 -> 2 -> null", error: false });
    expect(outputPreview(run("a", 1, ""))).toBeNull();
  });

  it("is the error for a run that failed", () => {
    expect(outputPreview(run("a", 1, "", { status: "COMPILATION_ERROR", compileOutput: text("Main.java:3: error: ';' expected", "  int x", "       ^") }))).toEqual({ text: "Main.java:3: error: ';' expected", error: true });
    const trace = text('Exception in thread "main" java.lang.ArithmeticException: / by zero', "  at Main.main(Main.java:3)");
    expect(outputPreview(run("a", 1, "", { status: "RUNTIME_ERROR", stdout: "before", stderr: trace }))?.text).toContain("ArithmeticException");
    expect(outputPreview(run("a", 1, "", { status: "RUNTIME_ERROR", stderr: text("Traceback (most recent call last):", '  File "main.py", line 1', "ZeroDivisionError: division by zero") }))?.text).toBe("ZeroDivisionError: division by zero");
    expect(outputPreview(run("a", 1, "", { status: "TIME_LIMIT", message: "Stopped after 10 s." }))).toEqual({ text: "Stopped after 10 s.", error: true });
  });
});

describe("how long ago", () => {
  it("is words for recent runs and nothing for older ones", () => {
    const now = 10 * 3600_000;
    expect(ago(now - 5_000, now)).toBe("just now");
    expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(ago(now - 2 * 3600_000, now)).toBe("2 h ago");
    expect(ago(now - 7 * 3600_000, now)).toBeNull();
  });
});
