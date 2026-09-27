import { describe, expect, it } from "vitest";
import type { HeapObject, Trace, TraceFrame, TraceStep, TraceValue } from "@cw/shared";
import { diffSteps, frameIds, indexPointers, layoutHeap, nameOf, preview, timeline } from "./model";

const int = (n: number): TraceValue => ({ kind: "value", text: String(n), type: "int" });
const ref = (id: string): TraceValue => ({ kind: "ref", id });
const list = (...items: TraceValue[]): HeapObject => ({ kind: "sequence", type: "list", items });
const frame = (name: string, line: number, locals: [string, TraceValue][], extra: Partial<TraceFrame> = {}): TraceFrame => ({ name, file: "main.py", line, locals, ...extra });
const step = (frames: TraceFrame[], heap: Record<string, HeapObject> = {}, extra: Partial<TraceStep> = {}): TraceStep => ({
  event: "line",
  frames,
  heap,
  stdoutLength: 0,
  ...extra,
});
const trace = (steps: TraceStep[], stdout = ""): Trace => ({ language: "python", steps, stdout });

describe("layoutHeap", () => {
  it("lays a linked list out left to right on one row", () => {
    const node = (v: number, next: TraceValue): HeapObject => ({ kind: "object", type: "Node", fields: [["value", int(v)], ["next", next]] });
    const none: TraceValue = { kind: "value", text: "None", type: "NoneType" };
    const s = step([frame("<module>", 1, [["head", ref("a")]])], { a: node(1, ref("b")), b: node(2, ref("c")), c: node(3, none) });
    expect(layoutHeap(s)).toEqual([
      { id: "a", row: 0, col: 0 },
      { id: "b", row: 0, col: 1 },
      { id: "c", row: 0, col: 2 },
    ]);
  });

  it("branches a tree downwards, shares objects once and skips hidden ones", () => {
    const s = step([frame("<module>", 1, [["f", ref("fn")], ["root", ref("r")], ["alias", ref("r")]])], {
      fn: { kind: "other", type: "function", text: "f(x)" },
      r: { kind: "object", type: "T", fields: [["left", ref("l")], ["right", ref("rr")]] },
      l: { kind: "object", type: "T", fields: [] },
      rr: { kind: "object", type: "T", fields: [["back", ref("r")]] },
    });
    expect(layoutHeap(s, (id) => id === "fn")).toEqual([
      { id: "r", row: 0, col: 0 },
      { id: "l", row: 0, col: 1 },
      { id: "rr", row: 1, col: 1 },
    ]);
  });
});

describe("diffSteps", () => {
  it("detects a swap of two list elements and names the list by its variable", () => {
    const t = trace([
      step([frame("bubble_sort", 11, [["arr", ref("L")], ["j", int(0)]])], { L: list(int(5), int(2), int(9)) }),
      step([frame("bubble_sort", 10, [["arr", ref("L")], ["j", int(0)]])], { L: list(int(2), int(5), int(9)) }),
    ]);
    const d = diffSteps(t, 1);
    expect(d.swaps.get("L")).toEqual([0, 1]);
    expect(d.changes).toEqual([{ tone: "mutate", parts: ["Swapped ", { code: "arr[0]" }, " and ", { code: "arr[1]" }] }]);
    expect(d.ranLine).toEqual({ file: "main.py", line: 11 });
  });

  it("narrates calls, returns, assignments, appends and output", () => {
    const t = trace(
      [
        step([frame("<module>", 7, [["nums", ref("L")]])], { L: list(int(1)) }),
        step([frame("<module>", 7, [["nums", ref("L")]]), frame("square", 2, [["x", int(3)]])], { L: list(int(1)) }),
        step([frame("<module>", 7, [["nums", ref("L")]]), frame("square", 2, [["x", int(3)]], { returnValue: int(9) })], { L: list(int(1)) }, { event: "return" }),
        step([frame("<module>", 8, [["nums", ref("L")], ["result", int(9)]])], { L: list(int(1)) }),
        step([frame("<module>", 9, [["nums", ref("L")], ["result", int(9)]])], { L: list(int(1), int(9)) }, { stdoutLength: 9 }),
      ],
      "result 9\n",
    );
    expect(diffSteps(t, 1).changes).toEqual([{ tone: "call", parts: ["Called ", { code: "square(x=3)" }] }]);
    expect(diffSteps(t, 1).newFrames).toEqual(new Set([1]));
    expect(diffSteps(t, 2).changes).toEqual([{ tone: "return", parts: [{ code: "square" }, " returns ", { code: "9" }] }]);
    expect(diffSteps(t, 3).changes).toEqual([{ tone: "assign", parts: [{ code: "result" }, " = ", { code: "9" }] }]);
    const last = diffSteps(t, 4);
    expect(last.changes).toEqual([
      { tone: "mutate", parts: ["Added ", { code: "9" }, " to ", { code: "nums" }] },
      { tone: "print", parts: ["Printed ", { code: "result 9" }] },
    ]);
    expect(last.highlights.has("cell:L:1")).toBe(true);
    expect(last.printed).toBe("result 9\n");
  });

  it("treats a recursive call right after a return as a new frame", () => {
    const t = trace([
      step([frame("main", 5, []), frame("fib", 3, [["n", int(1)]], { returnValue: int(1) })], {}, { event: "return" }),
      step([frame("main", 5, []), frame("fib", 2, [["n", int(0)]])]),
    ]);
    expect(diffSteps(t, 1).changes).toEqual([{ tone: "call", parts: ["Called ", { code: "fib(n=0)" }] }]);
    expect(frameIds(t)).toEqual([
      ["f0", "f1"],
      ["f0", "f2"],
    ]);
  });

  it("reports changed map entries and object fields by path", () => {
    const t = trace([
      step([frame("<module>", 3, [["d", ref("D")], ["p", ref("P")]])], {
        D: { kind: "map", type: "dict", entries: [[{ kind: "value", text: "'a'", type: "str" }, int(1)]] },
        P: { kind: "object", type: "Point", fields: [["x", int(0)]] },
      }),
      step([frame("<module>", 4, [["d", ref("D")], ["p", ref("P")]])], {
        D: { kind: "map", type: "dict", entries: [[{ kind: "value", text: "'a'", type: "str" }, int(2)]] },
        P: { kind: "object", type: "Point", fields: [["x", int(5)]] },
      }),
    ]);
    expect(diffSteps(t, 1).changes).toEqual([
      { tone: "mutate", parts: [{ code: "d['a']" }, " = ", { code: "2" }, " (was 1)"] },
      { tone: "mutate", parts: [{ code: "p.x" }, " = ", { code: "5" }] },
    ]);
  });

  it("reports exceptions", () => {
    const t = trace([step([frame("<module>", 1, [])]), step([frame("<module>", 1, [])], {}, { event: "exception", exception: "ZeroDivisionError: division by zero" })]);
    expect(diffSteps(t, 1).changes[0]).toEqual({ tone: "exception", parts: ["ZeroDivisionError: division by zero"] });
  });
});

describe("naming and previews", () => {
  it("names objects through fields when no variable holds them", () => {
    const s = step([frame("<module>", 1, [["head", ref("a")]])], {
      a: { kind: "object", type: "Node", fields: [["next", ref("b")]] },
      b: { kind: "object", type: "Node", fields: [["next", ref("c")]] },
      c: { kind: "object", type: "Node", fields: [] },
    });
    expect(nameOf(s, "b")).toBe("head.next");
    expect(nameOf(s, "c")).toBe("head.next.next");
    expect(preview(s, ref("a"))).toBe("Node(next=Node)");
  });
});

describe("indexPointers", () => {
  it("places index-like ints under the list the same frame holds", () => {
    const s = step([frame("f", 1, [["arr", ref("L")], ["i", int(0)], ["j", int(2)], ["n", int(3)], ["hi", int(7)]])], { L: list(int(1), int(2), int(3)) });
    expect(indexPointers(s)).toEqual(new Map([["L", new Map([[0, ["i"]], [2, ["j"]]])]]));
  });
});

describe("timeline", () => {
  it("records depth, output and exceptions per step", () => {
    const t = trace([
      step([frame("a", 1, [])]),
      step([frame("a", 1, []), frame("b", 1, [])], {}, { stdoutLength: 2 }),
      step([frame("a", 1, [])], {}, { event: "exception", stdoutLength: 2 }),
    ]);
    expect(timeline(t)).toEqual({ depth: [1, 2, 1], printed: [1], exceptions: [2], maxDepth: 2 });
  });
});
