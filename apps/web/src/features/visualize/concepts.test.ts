import { describe, expect, it } from "vitest";
import type { HeapObject, Trace, TraceStep, TraceValue } from "@cw/shared";
import { analyzeTrace, changedCells, detectStructures, detectWithCoverage, stableKeys, structureTitle, type Structure, type TreeNode } from "./concepts";

const int = (n: number): TraceValue => ({ kind: "value", text: String(n), type: "int" });
const str = (s: string): TraceValue => ({ kind: "value", text: `'${s}'`, type: "str" });
const bool = (b: boolean): TraceValue => ({ kind: "value", text: b ? "True" : "False", type: "bool" });
const none: TraceValue = { kind: "value", text: "None", type: "NoneType" };
const ref = (id: string): TraceValue => ({ kind: "ref", id });
const seq = (type: string, items: TraceValue[]): HeapObject => ({ kind: "sequence", type, items });
const obj = (type: string, fields: Record<string, TraceValue>): HeapObject => ({ kind: "object", type, fields: Object.entries(fields) });

function step(locals: Record<string, TraceValue>, heap: Record<string, HeapObject>): TraceStep {
  return { event: "line", frames: [{ name: "main", file: "main.py", line: 1, locals: Object.entries(locals) }], heap, stdoutLength: 0 };
}

const one = (s: TraceStep, kind: Structure["kind"]) => {
  const found = detectStructures(s).filter((x) => x.kind === kind);
  expect(found).toHaveLength(1);
  return found[0]!;
};

const labels = (n: TreeNode | null): unknown => (n ? [n.label && n.label.kind === "value" ? n.label.text : n.edge ?? "", ...n.children.map(labels)] : null);

describe("stacks and queues", () => {
  it("a list named stack is a stack with its top at the end", () => {
    const s = one(step({ stack: ref("1") }, { "1": seq("list", [int(1), int(2), int(3)]) }), "stack");
    expect(s).toMatchObject({ kind: "stack", name: "stack", topFirst: false });
    expect(structureTitle(s)).toBe("Stack");
  });

  it("Java's ArrayDeque used as a stack is turned so the top is last", () => {
    const s = one(step({ st: ref("1") }, { "1": seq("ArrayDeque", [int(3), int(2), int(1)]) }), "stack");
    expect(s.kind === "stack" && s.items.map((v) => (v as { text: string }).text)).toEqual(["1", "2", "3"]);
  });

  it("deques and Java queues are queues, front first", () => {
    expect(one(step({ q: ref("1") }, { "1": seq("deque", [int(3), int(4)]) }), "queue")).toMatchObject({ deque: false });
    expect(one(step({ line: ref("1") }, { "1": seq("LinkedList", [int(1)]) }), "queue")).toMatchObject({ kind: "queue" });
    expect(structureTitle(one(step({ dq: ref("1") }, { "1": seq("deque", [int(1)]) }), "queue"))).toBe("Deque");
  });

  it("a PriorityQueue or a list named heap is drawn as a heap tree, with its order", () => {
    const t = one(step({ pq: ref("1") }, { "1": seq("PriorityQueue", [int(1), int(3), int(2), int(7)]) }), "tree");
    expect(t).toMatchObject({ variant: "heap", heapOrder: "min" });
    expect(t.kind === "tree" && labels(t.root)).toEqual(["1", ["3", ["7"], null], ["2"]]);
    const max = one(step({ heap: ref("1") }, { "1": seq("list", [int(9), int(4), int(8)]) }), "tree");
    expect(structureTitle(max)).toBe("Max-heap");
  });
});

describe("hash maps and sets", () => {
  it("dicts, HashMaps and sets", () => {
    const m = one(step({ freq: ref("1") }, { "1": { kind: "map", type: "dict", entries: [[int(2), int(0)], [int(1), int(2)]] } }), "hash");
    expect(structureTitle(m)).toBe("Hash map");
    expect(structureTitle(one(step({ seen: ref("1") }, { "1": seq("HashSet", [int(1)]) }), "set"))).toBe("Hash set");
    expect(structureTitle(one(step({ m: ref("1") }, { "1": { kind: "map", type: "TreeMap", entries: [] } }), "hash"))).toBe("Sorted map");
  });

  it("C++ containers by their names, whatever the template arguments", () => {
    expect(structureTitle(one(step({ m: ref("1") }, { "1": { kind: "map", type: "map<string, int>", entries: [] } }), "hash"))).toBe("Sorted map");
    expect(structureTitle(one(step({ m: ref("1") }, { "1": { kind: "map", type: "unordered_map<string, int>", entries: [] } }), "hash"))).toBe("Hash map");
    expect(structureTitle(one(step({ s: ref("1") }, { "1": seq("set<int>", [int(1)]) }), "set"))).toBe("Sorted set");
    expect(structureTitle(one(step({ s: ref("1") }, { "1": seq("unordered_set<int>", [int(1)]) }), "set"))).toBe("Hash set");
    expect(one(step({ st: ref("1") }, { "1": seq("stack<int>", [int(1), int(2)]) }), "stack")).toBeTruthy();
    expect(one(step({ q: ref("1") }, { "1": seq("queue<int>", [int(1)]) }), "queue")).toBeTruthy();
  });
});

describe("linked lists", () => {
  const nodes = (ids: string[], links: (i: number) => Record<string, TraceValue>): Record<string, HeapObject> =>
    Object.fromEntries(ids.map((id, i) => [id, obj("Node", { val: int((i + 1) * 5), ...links(i) })]));

  it("singly, with the variables that point into it", () => {
    const heap = nodes(["a", "b", "c"], (i) => ({ next: i < 2 ? ref(["a", "b", "c"][i + 1]!) : none }));
    const l = one(step({ head: ref("a"), curr: ref("b") }, heap), "list");
    expect(l).toMatchObject({ variant: "singly", name: "head", truncated: false });
    expect(l.kind === "list" && l.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(l.kind === "list" && l.pointers.get("b")).toEqual(["curr"]);
  });

  it("doubly and circular", () => {
    const ids = ["a", "b", "c"];
    const doubly = nodes(ids, (i) => ({ prev: i > 0 ? ref(ids[i - 1]!) : none, next: i < 2 ? ref(ids[i + 1]!) : none }));
    expect(one(step({ head: ref("a") }, doubly), "list")).toMatchObject({ variant: "doubly" });
    const circular = nodes(ids, (i) => ({ next: ref(ids[(i + 1) % 3]!) }));
    const c = one(step({ head: ref("a") }, circular), "list");
    expect(c).toMatchObject({ variant: "circular" });
    expect(c.kind === "list" && c.nodes).toHaveLength(3);
  });
});

describe("trees", () => {
  const bin = (spec: Record<string, [number, string | null, string | null]>, extra: (id: string) => Record<string, TraceValue> = () => ({})) =>
    Object.fromEntries(Object.entries(spec).map(([id, [v, l, r]]) => [id, obj("TreeNode", { val: int(v), left: l ? ref(l) : none, right: r ? ref(r) : none, ...extra(id) })]));

  it("a binary search tree keeps left and right slots", () => {
    const heap = bin({ r: [8, "a", "b"], a: [3, null, "c"], b: [10, null, null], c: [6, null, null] });
    const t = one(step({ root: ref("r") }, heap), "tree");
    expect(t).toMatchObject({ variant: "bst", name: "root" });
    expect(t.kind === "tree" && labels(t.root)).toEqual(["8", ["3", null, ["6"]], ["10"]]);
  });

  it("a binary tree that is not sorted, AVL heights and red-black colours", () => {
    expect(one(step({ root: ref("r") }, bin({ r: [1, "a", null], a: [5, null, null] })), "tree")).toMatchObject({ variant: "binary" });
    const avl = one(step({ root: ref("r") }, bin({ r: [5, "a", null], a: [2, null, null] }, (id) => ({ height: int(id === "r" ? 2 : 1) }))), "tree");
    expect(avl).toMatchObject({ variant: "avl" });
    const rb = one(step({ root: ref("r") }, bin({ r: [5, "a", null], a: [2, null, null] }, (id) => ({ color: str(id === "r" ? "BLACK" : "RED") }))), "tree");
    expect(rb.kind === "tree" && [rb.variant, rb.root.color, rb.root.children[0]?.color]).toEqual(["red-black", "black", "red"]);
  });

  it("n-ary trees and tries", () => {
    const nary = {
      r: obj("Node", { val: int(1), children: ref("rc") }),
      rc: seq("list", [ref("x"), ref("y")]),
      x: obj("Node", { val: int(2), children: ref("xc") }),
      xc: seq("list", []),
      y: obj("Node", { val: int(3), children: ref("yc") }),
      yc: seq("list", []),
    };
    const t = one(step({ root: ref("r") }, nary), "tree");
    expect(t).toMatchObject({ variant: "n-ary" });
    expect(t.kind === "tree" && labels(t.root)).toEqual(["1", ["2"], ["3"]]);

    const trie = {
      r: obj("TrieNode", { children: ref("rc"), is_end: bool(false) }),
      rc: { kind: "map", type: "dict", entries: [[str("a"), ref("a")]] } as HeapObject,
      a: obj("TrieNode", { children: ref("ac"), is_end: bool(true) }),
      ac: { kind: "map", type: "dict", entries: [] } as HeapObject,
    };
    const tr = one(step({ root: ref("r") }, trie), "tree");
    expect(tr.kind === "tree" && [tr.variant, tr.root.children[0]?.edge, tr.root.children[0]?.end]).toEqual(["trie", "a", true]);
  });

  it("a segment tree array", () => {
    const t = one(step({ seg: ref("1") }, { "1": seq("list", [int(0), int(10), int(3), int(7), int(1), int(2), int(3), int(4)]) }), "tree");
    expect(t.kind === "tree" && labels(t.root)).toEqual(["10", ["3", ["1"], ["2"]], ["7", ["3"], ["4"]]]);
  });
});

describe("graphs", () => {
  it("an adjacency dict, with visited nodes, the queue and the current node", () => {
    const heap: Record<string, HeapObject> = {
      g: { kind: "map", type: "dict", entries: [[int(0), ref("n0")], [int(1), ref("n1")], [int(2), ref("n2")]] },
      n0: seq("list", [int(1), int(2)]),
      n1: seq("list", [int(0)]),
      n2: seq("list", [int(0)]),
      vis: seq("list", [bool(true), bool(true), bool(false)]),
      q: seq("deque", [int(2)]),
    };
    const g = one(step({ graph: ref("g"), visited: ref("vis"), queue: ref("q"), node: int(1), nbr: int(0) }, heap), "graph");
    expect(g.kind === "graph" && [g.directed, g.edges.length, [...g.visited], [...g.frontier], [...g.current], [...g.checking]]).toEqual([false, 2, ["0", "1"], ["2"], ["1"], ["0"]]);
  });

  it("a list of lists named adj, and weighted pairs", () => {
    const heap: Record<string, HeapObject> = {
      a: seq("list", [ref("r0"), ref("r1")]),
      r0: seq("list", [ref("p")]),
      r1: seq("list", []),
      p: seq("tuple", [int(1), int(7)]),
    };
    const g = one(step({ adj: ref("a") }, heap), "graph");
    expect(g.kind === "graph" && [g.directed, g.edges]).toEqual([true, [{ from: "0", to: "1", weight: "7" }]]);
  });
});

describe("edge lists", () => {
  it("rows of [from, to, weight] are edges, not neighbours of the row index", () => {
    const heap: Record<string, HeapObject> = {
      e: seq("int[][]", [ref("a"), ref("b")]),
      a: seq("int[]", [int(0), int(1), int(4)]),
      b: seq("int[]", [int(1), int(2), int(6)]),
    };
    const g = one(step({ edges: ref("e") }, heap), "graph");
    expect(g.kind === "graph" && [g.nodes.map((n) => n.key), g.edges]).toEqual([
      ["0", "1", "2"],
      [
        { from: "0", to: "1", weight: "4" },
        { from: "1", to: "2", weight: "6" },
      ],
    ]);
  });
});

describe("arrays", () => {
  it("a 2D array with the cell at [i][j]", () => {
    const heap = { m: seq("list", [ref("r0"), ref("r1")]), r0: seq("list", [int(1), int(2)]), r1: seq("list", [int(3), int(4)]) };
    const m = one(step({ dp: ref("m"), i: int(1), j: int(0) }, heap), "matrix");
    expect(m.kind === "matrix" && m.cell).toEqual([1, 0]);
  });

  it("index variables point into arrays and strings", () => {
    const a = one(step({ nums: ref("1"), left: int(0), right: int(2) }, { "1": seq("list", [int(1), int(2), int(3)]) }), "array");
    expect(a.kind === "array" && [...a.pointers]).toEqual([[0, ["left"]], [2, ["right"]]]);
    const s = detectStructures(step({ s: str("level"), i: int(1) }, {})).find((x) => x.kind === "array");
    expect(s).toMatchObject({ chars: true, name: "s" });
  });
});

describe("stable keys", () => {
  it("a dequeued element leaves and the rest keep their keys", () => {
    const trace: Trace = {
      language: "python",
      stdout: "",
      steps: [
        step({ q: ref("1") }, { "1": seq("deque", [int(3), int(4), int(5)]) }),
        step({ q: ref("1") }, { "1": seq("deque", [int(4), int(5), int(6)]) }),
      ],
    };
    const a = stableKeys(trace, "1", 0);
    const b = stableKeys(trace, "1", 1);
    expect(b.slice(0, 2)).toEqual(a.slice(1));
    expect(a).not.toContain(b[2]);
  });

  it("swapped elements keep their keys", () => {
    const trace: Trace = {
      language: "python",
      stdout: "",
      steps: [step({ a: ref("1") }, { "1": seq("list", [int(3), int(1)]) }), step({ a: ref("1") }, { "1": seq("list", [int(1), int(3)]) })],
    };
    const a = stableKeys(trace, "1", 0);
    expect(stableKeys(trace, "1", 1)).toEqual([a[1], a[0]]);
  });
});

describe("whole programs", () => {
  const node = (v: number, next: TraceValue = none) => obj("Node", { val: int(v), next });

  it("a node being unlinked is drawn above the list, pointing at the node it rejoins", () => {
    const heap = { a: node(1, ref("b")), b: node(2, ref("d")), c: node(3, ref("d")), d: node(4) };
    const l = one(step({ head: ref("a"), cur: ref("c") }, heap), "list");
    expect(l.kind === "list" && [l.name, l.nodes.map((n) => n.id), l.branches]).toEqual(["head", ["a", "b", "d"], [{ nodes: [{ id: "c", value: int(3) }], joinAt: 2 }]]);
  });

  it("a cycle into the middle of a list is drawn as a loop to that node", () => {
    const heap = { a: node(1, ref("b")), b: node(2, ref("c")), c: node(3, ref("b")) };
    expect(one(step({ head: ref("a") }, heap), "list")).toMatchObject({ variant: "singly", loopTo: 1, truncated: false });
  });

  it("decides from the whole run: a lone first node is already a list node, a one-node tree already a BST", () => {
    const trace: Trace = {
      language: "python",
      stdout: "",
      steps: [step({ head: ref("a") }, { a: node(1) }), step({ head: ref("a"), n: ref("x") }, { a: node(1), x: node(2) }), step({ head: ref("a") }, { a: node(1, ref("x")), x: node(2) })],
    };
    const hints = analyzeTrace(trace);
    expect(detectStructures(trace.steps[0]!, hints)[0]).toMatchObject({ kind: "list" });
    // Two unlinked nodes: still nodes, not two plain objects.
    expect(detectStructures(trace.steps[1]!, hints).map((s) => s.kind)).toEqual(["list", "list"]);

    const bst = (spec: Record<string, [number, string | null, string | null]>) =>
      Object.fromEntries(Object.entries(spec).map(([id, [v, l, r]]) => [id, obj("T", { key: int(v), left: l ? ref(l) : none, right: r ? ref(r) : none })]));
    const t2: Trace = { language: "python", stdout: "", steps: [step({ root: ref("r") }, bst({ r: [5, null, null] })), step({ root: ref("r") }, bst({ r: [5, "a", null], a: [2, null, null] }))] };
    expect(detectStructures(t2.steps[0]!, analyzeTrace(t2))[0]).toMatchObject({ kind: "tree", variant: "bst" });
  });

  it("only elements that are new or reassigned are highlighted, not ones that shifted", () => {
    const trace: Trace = {
      language: "python",
      stdout: "",
      steps: [step({ a: ref("1") }, { "1": seq("list", [int(1), int(2), int(3)]) }), step({ a: ref("1") }, { "1": seq("list", [int(1), int(9), int(2), int(3)]) }), step({ a: ref("1") }, { "1": seq("list", [int(1), int(9), int(7), int(3)]) })],
    };
    expect([...changedCells(trace, "1", 1)]).toEqual([1]);
    expect([...changedCells(trace, "1", 2)]).toEqual([2]);
  });

  it("a list inside an object stays in the object's card, unless the class is a stack or queue", () => {
    const plain = detectWithCoverage(step({ s: ref("o") }, { o: obj("Student", { name: str("Ana"), marks: ref("m") }), m: seq("list", [int(90)]) }));
    expect(plain.structures.map((x) => x.kind)).toEqual(["object"]);
    const wrapped = detectStructures(step({ s: ref("o") }, { o: obj("MyStack", { items: ref("m") }), m: seq("list", [int(1), int(2)]) }));
    expect(wrapped.map((x) => x.kind)).toEqual(["object", "stack"]);
  });
});
