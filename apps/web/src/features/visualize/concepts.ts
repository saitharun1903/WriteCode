import type { HeapObject, Trace, TraceStep, TraceValue } from "@cw/shared";
import { nameOf, preview, valueKey } from "./model";

/**
 * Recognises the data structures a program builds, from one recorded step,
 * so each can be drawn the way it is taught: a stack as a pile with a top, a
 * queue with a front and a rear, a linked list as a chain of nodes, a tree as
 * a tree, a graph as nodes and edges, a hash map as a table of keys and values.
 *
 * Everything comes from the recorded objects: their types (ArrayDeque,
 * PriorityQueue, deque, dict…), their shape (a node class with `next`, or with
 * `left` and `right`), and the names the program gives them (`stack`, `adj`,
 * `visited`). Anything not recognised is left to the memory view.
 */

export type ListVariant = "singly" | "doubly" | "circular" | "circular-doubly";
export type TreeVariant = "binary" | "bst" | "avl" | "red-black" | "ternary" | "n-ary" | "trie" | "heap" | "segment";

export interface TreeNode {
  /** Heap object id, or `<array id>#<index>` for array-based trees. */
  key: string;
  /** Array-based trees: the array index. */
  index?: number;
  label: TraceValue | null;
  /** Child slots in order; `null` keeps an empty left or right slot in place. */
  children: (TreeNode | null)[];
  /** Tries: the character on the edge into this node. */
  edge?: string;
  /** Tries: a word ends here. */
  end?: boolean;
  /** Red-black trees. */
  color?: "red" | "black";
  /** AVL trees: the stored height. */
  height?: string;
}

export interface GraphNode {
  key: string;
  label: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  weight?: string;
}

export type Structure =
  | { kind: "array"; id: string; name: string; type: string; items: TraceValue[]; omitted: number; pointers: Map<number, string[]>; chars?: boolean; label?: string }
  | { kind: "matrix"; id: string; name: string; type: string; rows: { id: string; items: TraceValue[] }[]; cell?: [number, number]; rowPointers: Map<number, string[]>; colPointers: Map<number, string[]> }
  /** `items` bottom to top; `topFirst` when the recorded order starts at the top (Java's ArrayDeque.push adds at the head). */
  | { kind: "stack"; id: string; name: string; type: string; items: TraceValue[]; omitted: number; topFirst: boolean }
  | { kind: "queue"; id: string; name: string; type: string; items: TraceValue[]; omitted: number; deque: boolean }
  | { kind: "hash"; id: string; name: string; type: string; entries: [TraceValue, TraceValue][]; omitted: number; ordered: boolean }
  | { kind: "set"; id: string; name: string; type: string; items: TraceValue[]; omitted: number; ordered: boolean }
  /** `loopTo`: the last node links back to this index (a cycle that does not return to the head). */
  | {
      kind: "list";
      id: string;
      name: string;
      type: string;
      variant: ListVariant;
      nodes: { id: string; value: TraceValue | null }[];
      pointers: Map<string, string[]>;
      truncated: boolean;
      loopTo?: number;
      /**
       * Chains that run into this list: a node being unlinked (`cur` still
       * points on to the list), or a second list sharing this one's tail.
       */
      branches?: { nodes: { id: string; value: TraceValue | null }[]; joinAt: number }[];
    }
  | { kind: "tree"; id: string; name: string; type: string; variant: TreeVariant; root: TreeNode; pointers: Map<string, string[]>; items?: TraceValue[]; heapOrder?: "min" | "max" }
  /** Any other object a variable holds: its fields, so nothing the program uses is left out. */
  | { kind: "object"; id: string; name: string; type: string; fields: [string, TraceValue][]; omitted: number }
  | {
      kind: "graph";
      id: string;
      name: string;
      type: string;
      nodes: GraphNode[];
      edges: GraphEdge[];
      directed: boolean;
      visited: Set<string>;
      frontier: Set<string>;
      current: Set<string>;
      /** The neighbour a traversal is looking at. */
      checking: Set<string>;
      badges: Map<string, string>;
    };

// -- Values

const isNull = (v: TraceValue | undefined) => !v || (v.kind === "value" && (v.text === "null" || v.text === "None" || v.text === "undefined"));
const refId = (v: TraceValue | undefined) => (v?.kind === "ref" ? v.id : null);
const NUMERIC = /^(int|float|long|double|short|byte|Integer|Long|Double|Float|Short|Byte|char|Character|BigInteger|bool|boolean|Boolean|number)$/;
const STRINGS = /^(str|String|string)$/;

/**
 * The class a node belongs to. JavaScript's plain objects all say `Object`,
 * so they are told apart by their fields: `{val, next}` nodes are one kind.
 */
export function groupOf(o: HeapObject): string {
  return o.type === "Object" ? `Object{${(o.fields ?? []).map(([n]) => n).sort().join(",")}}` : o.type;
}

/** Plain text of a scalar: numbers as written, strings without quotes. */
export function scalarText(v: TraceValue | undefined): string | null {
  if (!v || v.kind !== "value") return null;
  if (STRINGS.test(v.type) || v.type === "char" || v.type === "Character") return v.text.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return v.text;
}

function asNumber(v: TraceValue | undefined): number | null {
  if (!v || v.kind !== "value" || !NUMERIC.test(v.type) || v.type === "bool" || v.type === "boolean") return null;
  const n = Number(v.text);
  return Number.isFinite(n) ? n : null;
}

const isScalar = (v: TraceValue | undefined) => !!v && v.kind === "value";

// -- Names

const base = (name: string) => name.replace(/.*[.\]]/, "").replace(/\[.*$/, "");
const STACK_NAME = /stack|stk|^st\d?$|^stck$/i;
const HEAP_NAME = /heap|^pq\d?$|priority|^minh$|^maxh$/i;
const QUEUE_NAME = /queue|^q\d?$|^dq$|deque|^qu$|frontier|^bfs$/i;
const GRAPH_NAME = /^(adj\w*|graph\w*|g|gr|edges?|neighbou?rs|al|adjacency\w*)$/i;
const VISITED_NAME = /^(visited|vis|seen|used|marked|explored|done)$/i;
const DIST_NAME = /^(dist|dis|distance|distances|cost|costs|level|levels|depth)$/i;
const CURRENT_NAME = /^(u|node|cur|curr|current|vertex|vert|at|src|start)$/i;
const CHECKING_NAME = /^(v|nbr|neighbor|neighbour|nei|next_node|w|adj_node|child|to|dest)$/i;
const SEGMENT_NAME = /^(seg\w*|segment\w*|tree|st_?tree|sgt|segtree)$/i;
const FENWICK_NAME = /^(bit|fenwick\w*|fen|ft|bit_?tree)$/i;
const INDEX_NAME = /^(i|j|k|l|r|lo|low|hi|high|mid|left|right|start|end|begin|pos|idx|index|ptr|p1|p2|slow|fast|front|rear|top|a|b|m|n1|n2)$|(Index|Idx|_idx|_index|_pos|Ptr|_ptr)$/;
const ROW_NAME = /^(i|r|row|y)$/;
const COL_NAME = /^(j|c|col|column|x)$/;

// -- Node classes

const FIELD = {
  next: /^(next|nxt|link|succ|next_node|nextnode)$/i,
  prev: /^(prev|previous|pre|prv|back|prev_node|prevnode)$/i,
  left: /^(left|l|lchild|left_child|leftchild|lc|lo)$/i,
  right: /^(right|r|rchild|right_child|rightchild|rc|hi)$/i,
  mid: /^(mid|middle|eq|equal|center|centre|m)$/i,
  children: /^(children|child|kids|next|nodes|subtrees|links|edges|childs|sons)$/i,
  neighbors: /^(neighbors|neighbours|adj|adjacent|edges|nbrs|adjacency)$/i,
  value: /^(val|value|data|key|item|info|element|elem|v|num|x|ch|char|c|label|name|id|word)$/i,
  height: /^(height|ht|h)$/i,
  color: /^(color|colour|red|is_red|isred|black|is_black|isblack)$/i,
  end: /^(is_end|isend|end|is_word|isword|word_end|eow|terminal|is_terminal|isterminal|leaf|is_leaf|isleaf|end_of_word|endofword|isendofword|count|cnt)$/i,
};

interface Shape {
  kind: "list" | "binary" | "ternary" | "n-ary" | "trie" | "graph";
  next?: string;
  prev?: string;
  left?: string;
  right?: string;
  mid?: string;
  children?: string;
  value?: string;
  height?: string;
  color?: string;
  end?: string;
}

/** Field names of every object of a type, in their first order. */
function fieldNames(objects: HeapObject[]): string[] {
  const names: string[] = [];
  for (const o of objects) for (const [n] of o.fields ?? []) if (!names.includes(n)) names.push(n);
  return names;
}

function fieldOf(o: HeapObject, name: string | undefined): TraceValue | undefined {
  return name ? o.fields?.find(([n]) => n === name)?.[1] : undefined;
}

/** An object of a class, with the heap of the step it was seen in (to follow its references). */
interface Sample {
  o: HeapObject;
  heap: Record<string, HeapObject>;
}

/**
 * How a class's objects link to each other, if they are the nodes of a
 * structure. Decided from every object of the class seen in the whole run
 * when possible, so a lone first node is already known to be a list node.
 */
function shapeOf(type: string, samples: Sample[]): Shape | null {
  const objects = samples.map((x) => x.o);
  const names = fieldNames(objects);
  const sameType = (v: TraceValue | undefined, heap: Record<string, HeapObject>) => isNull(v) || (v?.kind === "ref" && !!heap[v.id] && groupOf(heap[v.id]!) === type);
  const every = (n: string) => samples.every(({ o, heap }) => sameType(fieldOf(o, n), heap));
  // A field that only ever holds null or another node of this class (and holds one at least once).
  const link = (re: RegExp) => names.find((n) => re.test(n) && every(n) && objects.some((o) => fieldOf(o, n)?.kind === "ref"));
  const linkOrNull = (re: RegExp) => names.find((n) => re.test(n) && every(n));
  // A field holding a list, array or map of nodes of this class.
  const container = (re: RegExp) =>
    names.find((n) => {
      if (!re.test(n)) return false;
      let seen = false;
      for (const { o, heap } of samples) {
        const v = fieldOf(o, n);
        if (isNull(v)) continue;
        const c = refId(v) ? heap[refId(v)!] : undefined;
        if (!c || (c.kind !== "sequence" && c.kind !== "map")) return false;
        const values = c.kind === "map" ? (c.entries ?? []).map(([, x]) => x) : (c.items ?? []);
        if (!values.every((x) => sameType(x, heap))) return false;
        seen = true;
      }
      return seen;
    });

  const scalarField = (re: RegExp, exclude: string[]) => names.find((n) => re.test(n) && !exclude.includes(n) && objects.every((o) => isScalar(fieldOf(o, n)) || isNull(fieldOf(o, n))));
  const extras = (used: string[]) => {
    const height = scalarField(FIELD.height, used);
    const color = scalarField(FIELD.color, used);
    const end = scalarField(FIELD.end, used);
    const skip = [...used, height, color, end].filter(Boolean) as string[];
    const value = scalarField(FIELD.value, skip) ?? names.find((n) => !skip.includes(n) && objects.every((o) => isScalar(fieldOf(o, n))));
    return { height, color, end, value };
  };

  const children = container(FIELD.children);
  if (children) {
    const found = samples.map(({ o, heap }) => heap[refId(fieldOf(o, children)) ?? ""]).find(Boolean);
    // Children keyed by character, or a fixed alphabet array with gaps: a trie.
    const trie = found?.kind === "map" || (found?.kind === "sequence" && (found.items?.length ?? 0) >= 26 && (found.items ?? []).some(isNull));
    return { kind: trie ? "trie" : "n-ary", children, ...extras([children]) };
  }
  const neighbors = container(FIELD.neighbors);
  if (neighbors) return { kind: "graph", children: neighbors, ...extras([neighbors]) };

  const single = new Set(samples.map(({ o }) => o)).size === 1 || objects.length === 1;
  const left = linkOrNull(FIELD.left);
  const right = linkOrNull(FIELD.right);
  if (left && right && left !== right && (objects.some((o) => fieldOf(o, left)?.kind === "ref" || fieldOf(o, right)?.kind === "ref") || single)) {
    const mid = linkOrNull(FIELD.mid);
    const usedMid = mid && mid !== left && mid !== right ? mid : undefined;
    return { kind: usedMid ? "ternary" : "binary", left, right, mid: usedMid, ...extras([left, right, usedMid].filter(Boolean) as string[]) };
  }
  const next = link(FIELD.next) ?? (single ? linkOrNull(FIELD.next) : undefined);
  if (next) {
    const prev = linkOrNull(FIELD.prev);
    return { kind: "list", next, prev: prev !== next ? prev : undefined, ...extras([next, prev].filter(Boolean) as string[]) };
  }
  return null;
}

// -- Decisions made once for the whole run

/**
 * What a structure is, decided from the whole run rather than one step, so it
 * keeps one identity: a class seen linking by `next` is a list node even
 * while its first node stands alone; a tree that is a BST once it has two
 * nodes is called a BST from its first node; a map that becomes a graph is
 * drawn as a graph from its first key.
 */
export interface TraceHints {
  shapes: Map<string, Shape>;
  treeVariant: Map<string, TreeVariant>;
  doubly: Set<string>;
  /** Object ids drawn as graphs at some step, with whether the graph is directed at its last step. */
  graphs: Map<string, boolean>;
}

const hintCache = new WeakMap<Trace, TraceHints>();

export function analyzeTrace(trace: Trace): TraceHints {
  const cached = hintCache.get(trace);
  if (cached) return cached;
  // Up to ~300 steps, spread over the run, keep this fast for long traces.
  const every = Math.max(1, Math.ceil(trace.steps.length / 300));
  const steps = trace.steps.filter((_, i) => i % every === 0 || i === trace.steps.length - 1);
  const samples = new Map<string, Sample[]>();
  for (const step of steps)
    for (const o of Object.values(step.heap)) {
      if (o.kind !== "object") continue;
      const list = samples.get(groupOf(o)) ?? [];
      if (list.length < 400) list.push({ o, heap: step.heap });
      samples.set(groupOf(o), list);
    }
  const shapes = new Map<string, Shape>();
  for (const [type, list] of samples) {
    const shape = shapeOf(type, list);
    if (shape) shapes.set(type, shape);
  }
  const partial: TraceHints = { shapes, treeVariant: new Map(), doubly: new Set(), graphs: new Map() };
  const sorted = new Map<string, boolean>();
  // Observe with the class shapes only; the other decisions are what this pass is working out.
  const probe: TraceHints = { shapes, treeVariant: new Map(), doubly: new Set(), graphs: new Map() };
  for (const step of steps) {
    for (const s of detectWithCoverage(step, probe).structures) {
      if (s.kind === "tree" && (s.variant === "binary" || s.variant === "bst" || s.variant === "avl")) {
        let n = 0;
        const count = (t: TreeNode | null) => t && (n++, t.children.forEach(count));
        count(s.root);
        if (n >= 2) sorted.set(s.type, (sorted.get(s.type) ?? true) && s.variant !== "binary");
      }
      if (s.kind === "list" && (s.variant === "doubly" || s.variant === "circular-doubly")) partial.doubly.add(s.type);
      if (s.kind === "graph") partial.graphs.set(s.id, s.directed);
    }
  }
  for (const [type, ok] of sorted) {
    const shape = shapes.get(type);
    partial.treeVariant.set(type, ok ? (shape?.height ? "avl" : "bst") : "binary");
  }
  hintCache.set(trace, partial);
  return partial;
}

// -- Stable identity across steps

const keyCache = new WeakMap<Trace, Map<string, { upTo: number; keys: (string[] | null)[]; counter: number }>>();

function itemsOf(o: HeapObject | undefined): string[] | null {
  if (!o) return null;
  if (o.kind === "sequence") return (o.items ?? []).map(valueKey);
  return null;
}

/**
 * Keys that follow each element of a sequence from step to step, so a
 * dequeued element leaves from the front and the rest slide along, and
 * sorted elements travel to their new places instead of changing in place.
 * Elements are matched to the previous step's by a longest common subsequence.
 */
export function stableKeys(trace: Trace, id: string, stepIndex: number): string[] {
  let perTrace = keyCache.get(trace);
  if (!perTrace) keyCache.set(trace, (perTrace = new Map()));
  let entry = perTrace.get(id);
  if (!entry) perTrace.set(id, (entry = { upTo: -1, keys: [], counter: 0 }));
  const fresh = () => `${id}~${entry!.counter++}`;
  for (let s = entry.upTo + 1; s <= stepIndex; s++) {
    const cur = itemsOf(trace.steps[s]?.heap[id]);
    if (!cur) {
      entry.keys[s] = null;
      continue;
    }
    let prevKeys: string[] | null = null;
    let prev: string[] | null = null;
    for (let p = s - 1; p >= 0 && prevKeys === null; p--) {
      if (entry.keys[p]) {
        prevKeys = entry.keys[p]!;
        prev = itemsOf(trace.steps[p]!.heap[id]);
      }
    }
    if (!prev || !prevKeys) {
      entry.keys[s] = cur.map(() => fresh());
      continue;
    }
    // LCS table, then walk it to pair equal elements in order.
    const n = prev.length;
    const m = cur.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = prev[i] === cur[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    const keys: string[] = new Array<string>(m);
    const used = new Set<number>();
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (prev[i] === cur[j]) {
        keys[j] = prevKeys[i]!;
        used.add(i);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
      else j++;
    }
    // Unmatched elements that took an unmatched element's value: moved (a swap or a shift).
    const spare = prev.map((v, k) => (used.has(k) ? null : { v, k })).filter((x): x is { v: string; k: number } => !!x);
    for (let k = 0; k < m; k++) {
      if (keys[k]) continue;
      const hit = spare.findIndex((x) => x.v === cur[k]);
      keys[k] = hit >= 0 ? prevKeys[spare.splice(hit, 1)[0]!.k]! : fresh();
    }
    entry.keys[s] = keys;
  }
  entry.upTo = Math.max(entry.upTo, stepIndex);
  return entry.keys[stepIndex] ?? [];
}

/**
 * Positions whose element is new since the previous step, or kept its
 * identity but got a new value (`arr[i] = x`). Elements that only moved (a
 * shift after an insert, a swap) are not listed: their movement shows it.
 */
export function changedCells(trace: Trace, id: string, stepIndex: number): Set<number> {
  const out = new Set<number>();
  const before = stepIndex > 0 ? itemsOf(trace.steps[stepIndex - 1]?.heap[id]) : null;
  const now = itemsOf(trace.steps[stepIndex]?.heap[id]);
  if (!before || !now) return out;
  const prevKeys = stableKeys(trace, id, stepIndex - 1);
  const keys = stableKeys(trace, id, stepIndex);
  const was = new Map(prevKeys.map((k, i) => [k, before[i]]));
  keys.forEach((k, i) => {
    if (!was.has(k) || was.get(k) !== now[i]) out.add(i);
  });
  return out;
}

// -- Detection

interface Named {
  id: string;
  name: string;
  /** Reached through a field of an object a variable holds (`s.items`), not a variable. */
  fromField?: boolean;
  /** The holder's class says what it is: a `MyStack`'s list is a stack. */
  concept?: "stack" | "queue" | "heap";
}

/** Variables of the frames that hold scalars, innermost frame first (for pointers). */
type Scalar = Extract<TraceValue, { kind: "value" }>;

function scalarLocals(step: TraceStep): [string, Scalar][] {
  const out: [string, Scalar][] = [];
  const seen = new Set<string>();
  for (let f = step.frames.length - 1; f >= 0; f--) {
    for (const [n, v] of step.frames[f]!.locals) {
      if (v.kind !== "value" || seen.has(n)) continue;
      seen.add(n);
      out.push([n, v]);
    }
  }
  return out;
}

/** Names that point at node objects: variables (innermost frame wins), then fields of non-node objects (`list.head`). */
function nodePointers(step: TraceStep, nodes: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, name: string) => {
    const list = out.get(id) ?? [];
    if (!list.includes(name)) out.set(id, [...list, name]);
  };
  const seen = new Set<string>();
  for (let f = step.frames.length - 1; f >= 0; f--) {
    for (const [n, v] of step.frames[f]!.locals) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (v.kind === "ref" && nodes.has(v.id)) add(v.id, n);
    }
  }
  for (const [id, o] of Object.entries(step.heap)) {
    if (nodes.has(id)) continue;
    for (const [n, v] of o.fields ?? []) if (v.kind === "ref" && nodes.has(v.id)) add(v.id, n);
  }
  return out;
}

function indexPointersFor(step: TraceStep, length: number, frameHint: number): Map<number, string[]> {
  const at = new Map<number, string[]>();
  // Index variables of the frame that holds the array, else of the innermost frame.
  const frames = [frameHint, step.frames.length - 1].filter((f, i, a) => f >= 0 && a.indexOf(f) === i);
  for (const f of frames) {
    for (const [n, v] of step.frames[f]!.locals) {
      if (v.kind !== "value" || !INDEX_NAME.test(n) || !/^-?\d+$/.test(v.text) || !/^(int|long|short|byte|Integer|Long|Short|number)$/.test(v.type)) continue;
      const i = Number(v.text);
      if (i < 0 || i > length) continue;
      if (![...at.values()].some((names) => names.includes(n))) at.set(i, [...(at.get(i) ?? []), n]);
    }
  }
  return at;
}

function frameOf(step: TraceStep, id: string): number {
  for (let f = step.frames.length - 1; f >= 0; f--) if (step.frames[f]!.locals.some(([, v]) => v.kind === "ref" && v.id === id)) return f;
  return -1;
}

function heapOrder(items: TraceValue[]): "min" | "max" | undefined {
  const nums = items.map(asNumber);
  if (nums.length < 3 || nums.some((x) => x === null)) return undefined;
  const ok = (cmp: (a: number, b: number) => boolean) => nums.every((x, i) => i === 0 || cmp(nums[(i - 1) >> 1]!, x!));
  if (ok((p, c) => p <= c)) return "min";
  if (ok((p, c) => p >= c)) return "max";
  return undefined;
}

/** An array laid out as a binary tree: children of i at 2i+1 and 2i+2 (heaps), or 2i and 2i+1 from 1 (segment trees). */
function arrayTree(id: string, items: TraceValue[], oneBased: boolean, pruneZero: boolean): TreeNode | null {
  const zero = (i: number): boolean => {
    if (i >= items.length) return true;
    const v = items[i];
    return (isNull(v) || asNumber(v) === 0) && zero(oneBased ? 2 * i : 2 * i + 1) && zero(oneBased ? 2 * i + 1 : 2 * i + 2);
  };
  const build = (i: number, depth: number): TreeNode | null => {
    if (i >= items.length || depth > 7 || (pruneZero && zero(i) && i !== (oneBased ? 1 : 0))) return null;
    const l = build(oneBased ? 2 * i : 2 * i + 1, depth + 1);
    const r = build(oneBased ? 2 * i + 1 : 2 * i + 2, depth + 1);
    return { key: `${id}#${i}`, index: i, label: items[i] ?? null, children: l || r ? [l, r] : [] };
  };
  return build(oneBased ? 1 : 0, 0);
}

function inOrderSorted(root: TreeNode): boolean {
  const vals: number[] = [];
  const strs: string[] = [];
  const walk = (n: TreeNode | null) => {
    if (!n) return;
    walk(n.children[0] ?? null);
    const x = asNumber(n.label ?? undefined);
    if (x !== null) vals.push(x);
    else if (n.label) strs.push(scalarText(n.label) ?? "");
    walk(n.children[1] ?? null);
  };
  walk(root);
  if (vals.length >= 2 && strs.length === 0) return vals.every((x, i) => i === 0 || vals[i - 1]! <= x);
  if (strs.length >= 2 && vals.length === 0) return strs.every((x, i) => i === 0 || strs[i - 1]! <= x);
  return false;
}

function truthy(v: TraceValue | undefined): boolean {
  const t = scalarText(v);
  return !!t && !/^(false|False|0|null|None|'?\\?0'?)$/.test(t);
}

function nodeStructures(step: TraceStep, consumed: Set<string>, hints?: TraceHints): Structure[] {
  const byType = new Map<string, [string, HeapObject][]>();
  for (const [id, o] of Object.entries(step.heap)) if (o.kind === "object") byType.set(groupOf(o), [...(byType.get(groupOf(o)) ?? []), [id, o]]);
  const out: Structure[] = [];
  for (const [type, list] of byType) {
    const shape = hints?.shapes.has(type) ? hints.shapes.get(type)! : shapeOf(type, list.map(([, o]) => ({ o, heap: step.heap })));
    if (!shape) continue;
    const ids = new Set(list.map(([id]) => id));
    const obj = (id: string) => step.heap[id]!;
    const value = (id: string) => fieldOf(obj(id), shape.value) ?? null;
    // Structural links out of a node, in order.
    const links = (id: string): (string | null)[] => {
      const o = obj(id);
      if (shape.kind === "list") return [refId(fieldOf(o, shape.next))];
      if (shape.kind === "binary") return [refId(fieldOf(o, shape.left)), refId(fieldOf(o, shape.right))];
      if (shape.kind === "ternary") return [refId(fieldOf(o, shape.left)), refId(fieldOf(o, shape.mid)), refId(fieldOf(o, shape.right))];
      const c = step.heap[refId(fieldOf(o, shape.children)) ?? ""];
      if (!c) return [];
      return c.kind === "map" ? (c.entries ?? []).map(([, v]) => refId(v)) : (c.items ?? []).map((v) => refId(v));
    };
    const referenced = new Set<string>();
    for (const id of ids) for (const c of links(id)) if (c && c !== id) referenced.add(c);
    const pointers = nodePointers(step, ids);
    const named = (id: string) => {
      for (const f of step.frames) for (const [n, v] of f.locals) if (v.kind === "ref" && v.id === id && n !== "self" && n !== "this") return n;
      return pointers.get(id)?.find((n) => n !== "self" && n !== "this") ?? pointers.get(id)?.[0] ?? nameOf(step, id);
    };
    let roots = [...ids].filter((id) => !referenced.has(id));
    // A circular list has no unreferenced node: start where a variable points, preferring `head`.
    if (shape.kind === "list" || shape.kind === "graph") {
      const covered = new Set<string>();
      const walk = (id: string) => {
        const stack = [id];
        while (stack.length) {
          const x = stack.pop()!;
          if (covered.has(x)) continue;
          covered.add(x);
          for (const c of links(x)) if (c && ids.has(c)) stack.push(c);
        }
      };
      roots.forEach(walk);
      const rest = [...ids].filter((id) => !covered.has(id));
      const preferred = rest.sort((a, b) => Number(/head|first|root|start/i.test(pointers.get(b)?.join() ?? "")) - Number(/head|first|root|start/i.test(pointers.get(a)?.join() ?? "")));
      for (const id of preferred) {
        if (covered.has(id)) continue;
        roots.push(id);
        walk(id);
      }
    }
    // Orphans with no variable pointing at them are garbage waiting to be collected: leave them out.
    // (Any frame counts: a recursive call's `root = null` must not hide the caller's `root`.)
    const held = (id: string) => step.frames.some((f) => f.locals.some(([, v]) => v.kind === "ref" && v.id === id));
    roots = roots.filter((id) => pointers.has(id) || held(id) || links(id).some(Boolean) || [...Object.values(step.heap)].some((o) => o.kind !== "object" && (o.items ?? []).some((v) => refId(v) === id)));

    if (shape.kind === "graph") {
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const seen = new Set<string>();
      const stack = [...roots];
      while (stack.length && nodes.length < 60) {
        const id = stack.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        nodes.push({ key: id, label: scalarText(value(id) ?? undefined) ?? preview(step, value(id) ?? undefined) });
        for (const c of links(id)) if (c && ids.has(c)) {
          edges.push({ from: id, to: c });
          stack.push(c);
        }
      }
      if (nodes.length < (hints?.graphs.has(roots[0]!) ? 1 : 2)) continue;
      nodes.forEach((n) => consumed.add(n.key));
      const undirected = hints?.graphs.has(roots[0]!) ? !hints.graphs.get(roots[0]!) : edges.every((e) => edges.some((x) => x.from === e.to && x.to === e.from));
      out.push({
        kind: "graph",
        id: roots[0]!,
        name: named(roots[0]!),
        type,
        nodes,
        edges: undirected ? edges.filter((e) => e.from < e.to) : edges,
        directed: !undirected,
        visited: new Set(),
        frontier: new Set(),
        current: new Set([...pointers.keys()].filter((id) => seen.has(id))),
        checking: new Set(),
        badges: new Map(),
      });
      continue;
    }

    if (shape.kind === "list") {
      const length = (id: string) => {
        const seenHere = new Set<string>();
        let cur: string | null = id;
        while (cur && ids.has(cur) && !seenHere.has(cur)) {
          seenHere.add(cur);
          cur = links(cur)[0] ?? null;
        }
        return seenHere.size;
      };
      const main = (id: string) => (pointers.get(id) ?? []).some((n) => /^(head|first|root|start|front|dummy|sentinel|list)$/i.test(n));
      roots.sort((a, b) => Number(main(b)) - Number(main(a)) || length(b) - length(a));
    }
    const owner = new Map<string, { list: Extract<Structure, { kind: "list" }>; index: number }>();
    for (const root of roots) {
      if (consumed.has(root)) continue;
      if (shape.kind === "list") {
        const nodes: { id: string; value: TraceValue | null }[] = [];
        const at = new Map<string, number>();
        let cur: string | null = root;
        let loopTo = -1;
        let join: { list: Extract<Structure, { kind: "list" }>; index: number } | undefined;
        while (cur && ids.has(cur) && nodes.length < 60) {
          if (at.has(cur)) {
            loopTo = at.get(cur)!;
            break;
          }
          join = owner.get(cur);
          if (join) break;
          at.set(cur, nodes.length);
          nodes.push({ id: cur, value: value(cur) });
          cur = links(cur)[0] ?? null;
        }
        if (nodes.length === 0) continue;
        nodes.forEach((n) => consumed.add(n.id));
        if (join) {
          // Runs into a list already drawn: shown above it, pointing at the node it joins.
          (join.list.branches ??= []).push({ nodes, joinAt: join.index });
          continue;
        }
        const doubly = !!shape.prev && (hints?.doubly.has(type) || nodes.some((n) => fieldOf(obj(n.id), shape.prev)?.kind === "ref"));
        const circular = loopTo === 0;
        const list: Extract<Structure, { kind: "list" }> = {
          kind: "list",
          id: root,
          name: named(root),
          type,
          variant: circular ? (doubly ? "circular-doubly" : "circular") : doubly ? "doubly" : "singly",
          nodes,
          pointers,
          truncated: !!cur && loopTo < 0,
          ...(loopTo > 0 ? { loopTo } : {}),
        };
        nodes.forEach((n, index) => owner.set(n.id, { list, index }));
        out.push(list);
        continue;
      }
      // Trees.
      const seen = new Set<string>();
      const build = (id: string | null, edge?: string): TreeNode | null => {
        if (!id || !ids.has(id) || seen.has(id) || seen.size > 127) return null;
        seen.add(id);
        const o = obj(id);
        const node: TreeNode = { key: id, label: shape.kind === "trie" ? null : value(id), children: [] };
        if (edge !== undefined) node.edge = edge;
        if (shape.height) node.height = scalarText(fieldOf(o, shape.height)) ?? undefined;
        if (shape.color) {
          const c = scalarText(fieldOf(o, shape.color)) ?? "";
          const redField = /red/i.test(shape.color);
          node.color = redField ? (truthy(fieldOf(o, shape.color)) ? "red" : "black") : /red|^r$|^1$|true/i.test(c) ? "red" : "black";
        }
        if (shape.end) node.end = truthy(fieldOf(o, shape.end));
        if (shape.kind === "trie") {
          const c = step.heap[refId(fieldOf(o, shape.children)) ?? ""];
          const pairs: [string, string | null][] =
            c?.kind === "map"
              ? (c.entries ?? []).map(([k, v]) => [scalarText(k) ?? "?", refId(v)])
              : (c?.items ?? []).map((v, i) => [String.fromCharCode(97 + i), refId(v)]);
          node.children = pairs.filter(([, v]) => v).map(([k, v]) => build(v, k)).filter((x): x is TreeNode => !!x);
        } else if (shape.kind === "binary") {
          const [l, r] = links(id);
          const left = build(l ?? null);
          const right = build(r ?? null);
          node.children = left || right ? [left, right] : [];
        } else {
          const kids = links(id).map((c) => build(c));
          node.children = shape.kind === "ternary" ? (kids.some(Boolean) ? kids : []) : kids.filter((x): x is TreeNode => !!x);
        }
        return node;
      };
      const tree = build(root);
      if (!tree) continue;
      seen.forEach((id) => consumed.add(id));
      let variant: TreeVariant = shape.kind === "trie" ? "trie" : shape.kind === "ternary" ? "ternary" : shape.kind === "n-ary" ? "n-ary" : "binary";
      if (variant === "binary") {
        const sorted = inOrderSorted(tree);
        if (shape.color) variant = "red-black";
        else if (hints?.treeVariant.has(type)) variant = hints.treeVariant.get(type)!;
        else if (shape.height && sorted) variant = "avl";
        else if (sorted) variant = "bst";
      }
      out.push({ kind: "tree", id: root, name: named(root), type, variant, root: tree, pointers });
    }
  }
  return out;
}

const QUEUE_TYPES = /^(deque|ArrayDeque|LinkedList|Queue|SimpleQueue|LinkedBlockingQueue|ArrayBlockingQueue|ConcurrentLinkedQueue|LinkedBlockingDeque)$/;
const STACK_TYPES = /^(Stack|LifoQueue)$/;
const HEAP_TYPES = /^(PriorityQueue|PriorityBlockingQueue)$/;
const MAP_TYPES = /^(dict|defaultdict|OrderedDict|Counter|HashMap|LinkedHashMap|TreeMap|Hashtable|ConcurrentHashMap|WeakHashMap|IdentityHashMap|Map|Object)$/;
const SET_TYPES = /^(set|frozenset|HashSet|LinkedHashSet|TreeSet|Set)$/;
const ORDERED = /^(TreeMap|TreeSet)$/;

/** A dict or map, a list of lists, or an adjacency matrix read as a graph. */
function graphFrom(step: TraceStep, id: string, name: string, hints?: TraceHints, obj?: HeapObject): Structure | null {
  const known = hints?.graphs.has(id) ?? false;
  const o = obj ?? step.heap[id]!;
  const edges: GraphEdge[] = [];
  const keys: string[] = [];
  // One adjacency entry: neighbours as scalars, or [neighbour, weight] pairs.
  const neighbours = (from: string, v: TraceValue): boolean => {
    const c = step.heap[refId(v) ?? ""];
    if (!c) return false;
    const items = c.kind === "sequence" ? (c.items ?? []) : c.kind === "map" ? (c.entries ?? []).map(([k]) => k) : null;
    if (!items) return false;
    const weights = c.kind === "map" ? (c.entries ?? []).map(([, w]) => scalarText(w) ?? undefined) : [];
    for (const [i, x] of items.entries()) {
      if (isScalar(x)) edges.push({ from, to: scalarText(x)!, ...(weights[i] !== undefined ? { weight: weights[i] } : {}) });
      else {
        const pair = step.heap[refId(x) ?? ""];
        const p = pair?.kind === "sequence" ? (pair.items ?? []) : pair?.kind === "object" ? (pair.fields ?? []).map(([, f]) => f) : [];
        if (p.length < 1 || !p.every(isScalar)) return false;
        edges.push({ from, to: scalarText(p[0])!, ...(p.length > 1 ? { weight: scalarText(p[1])! } : {}) });
      }
    }
    return true;
  };
  if (o.kind === "map") {
    for (const [k, v] of o.entries ?? []) {
      if (!isScalar(k) || !neighbours(scalarText(k)!, v)) return null;
      keys.push(scalarText(k)!);
    }
    // Without a graph-like name, every neighbour must itself be a key.
    if (!known && !GRAPH_NAME.test(base(name)) && (keys.length < 2 || !edges.every((e) => keys.includes(e.to)))) return null;
  } else if (o.kind === "sequence") {
    const rows = o.items ?? [];
    if (!(known || GRAPH_NAME.test(base(name))) || rows.length < 1) return null;
    const matrix = rows.map((r) => step.heap[refId(r) ?? ""]).every((r) => r?.kind === "sequence" && r.items?.length === rows.length && r.items.every((x) => asNumber(x) !== null));
    if (matrix) {
      rows.forEach((r, i) => {
        keys.push(String(i));
        step.heap[refId(r)!]!.items!.forEach((x, j) => {
          const w = asNumber(x)!;
          if (w !== 0 && Math.abs(w) < 1e9 && i !== j) edges.push({ from: String(i), to: String(j), ...(w !== 1 ? { weight: String(w) } : {}) });
        });
      });
    } else if (/^(edges?|edge_?list|connections|roads|flights|pairs)$/i.test(base(name))) {
      // An edge list: each row is [from, to] or [from, to, weight].
      for (const r of rows) {
        const e = step.heap[refId(r)!]!.items ?? [];
        if (e.length < 2 || e.length > 3 || !e.every(isScalar)) return null;
        for (const k of [scalarText(e[0])!, scalarText(e[1])!]) if (!keys.includes(k)) keys.push(k);
        edges.push({ from: scalarText(e[0])!, to: scalarText(e[1])!, ...(e.length === 3 ? { weight: scalarText(e[2])! } : {}) });
      }
    } else {
      for (const [i, r] of rows.entries()) {
        keys.push(String(i));
        if (!neighbours(String(i), r)) return null;
      }
      if (!edges.every((e) => /^\d+$/.test(e.to) && Number(e.to) < rows.length)) return null;
    }
  } else return null;
  for (const e of edges) if (!keys.includes(e.to)) keys.push(e.to);
  if (keys.length < (known ? 0 : 2) || keys.length > 60) return null;
  const undirected = known ? !hints!.graphs.get(id) : edges.length > 0 && edges.every((e) => edges.some((x) => x.from === e.to && x.to === e.from));
  return {
    kind: "graph",
    id,
    name,
    type: o.type,
    nodes: keys.map((k) => ({ key: k, label: k })),
    edges: undirected ? edges.filter((e) => (/^\d+$/.test(e.from) && /^\d+$/.test(e.to) ? Number(e.from) < Number(e.to) : e.from < e.to)) : edges,
    directed: !undirected,
    visited: new Set(),
    frontier: new Set(),
    current: new Set(),
    checking: new Set(),
    badges: new Map(),
  };
}

/** Marks a graph's nodes from the program's own bookkeeping: visited, the queue or stack, the current node, distances. */
function annotateGraph(step: TraceStep, g: Extract<Structure, { kind: "graph" }>, structures: Structure[]) {
  const keys = new Set(g.nodes.map((n) => n.key));
  const numericKeys = g.nodes.every((n) => /^\d+$/.test(n.key));
  for (const s of structures) {
    const n = base(s.name);
    if (VISITED_NAME.test(n)) {
      if (s.kind === "set") s.items.forEach((v) => keys.has(scalarText(v) ?? "") && g.visited.add(scalarText(v)!));
      if (s.kind === "array" && numericKeys) s.items.forEach((v, i) => truthy(v) && keys.has(String(i)) && g.visited.add(String(i)));
      if (s.kind === "hash") s.entries.forEach(([k, v]) => truthy(v) && keys.has(scalarText(k) ?? "") && g.visited.add(scalarText(k)!));
    }
    if (s.kind === "queue" || s.kind === "stack") s.items.forEach((v) => keys.has(scalarText(v) ?? "") && g.frontier.add(scalarText(v)!));
    if (DIST_NAME.test(n)) {
      if (s.kind === "array" && numericKeys) s.items.forEach((v, i) => keys.has(String(i)) && g.badges.set(String(i), scalarText(v) ?? ""));
      if (s.kind === "hash") s.entries.forEach(([k, v]) => keys.has(scalarText(k) ?? "") && g.badges.set(scalarText(k)!, scalarText(v) ?? ""));
    }
  }
  const top = step.frames[step.frames.length - 1];
  for (const [n, v] of top?.locals ?? []) {
    const k = scalarText(v) ?? "";
    if (!keys.has(k) || v.kind !== "value") continue;
    if (CURRENT_NAME.test(n)) g.current.add(k);
    else if (CHECKING_NAME.test(n)) g.checking.add(k);
  }
}

/** Every structure recognised in a step, in the order the program's variables name them. */
export function detectStructures(step: TraceStep, hints?: TraceHints): Structure[] {
  return detectWithCoverage(step, hints).structures;
}

/** The structures, and the ids of every object they draw. */
export function detectWithCoverage(step: TraceStep, hints?: TraceHints): { structures: Structure[]; consumed: Set<string> } {
  const consumed = new Set<string>();
  const nodes = nodeStructures(step, consumed, hints);
  const out: Structure[] = [];
  const named: Named[] = [];
  const seen = new Set<string>();
  const conceptOf = (type: string) => (/stack/i.test(type) ? "stack" : /heap|priority/i.test(type) ? "heap" : /queue|deque/i.test(type) ? "queue" : undefined);
  const owned = new Map<string, "stack" | "queue" | "heap">();
  for (const o of Object.values(step.heap)) {
    const c = o.kind === "object" ? conceptOf(o.type) : undefined;
    if (c) for (const [field, v] of o.fields ?? []) if (v.kind === "ref" && !field.startsWith("_") && step.heap[v.id]?.kind === "sequence") owned.set(v.id, c);
  }
  // Collections in the order variables (then fields) reach them, outermost frame first.
  for (const f of step.frames) {
    for (const [, v] of f.locals) {
      if (v.kind === "ref" && !seen.has(v.id)) {
        seen.add(v.id);
        const c = owned.get(v.id);
        named.push({ id: v.id, name: nameOf(step, v.id), ...(c ? { concept: c } : {}) });
      }
    }
  }
  // Collections kept in fields of objects the variables hold (a class's `self.items`), skipping private internals.
  const held = new Set<string>();
  for (const f of step.frames) for (const [, v] of f.locals) if (v.kind === "ref") held.add(v.id);
  for (const id of held) {
    const o = step.heap[id];
    if (!o || o.kind !== "object" || consumed.has(id)) continue;
    const concept = conceptOf(o.type);
    for (const [field, v] of o.fields ?? []) {
      if (v.kind !== "ref" || seen.has(v.id) || field.startsWith("_")) continue;
      seen.add(v.id);
      named.push({ id: v.id, name: nameOf(step, v.id), fromField: true, ...(concept ? { concept } : {}) });
    }
  }

  for (const { id, name, fromField, concept } of named) {
    if (consumed.has(id)) continue;
    const found = step.heap[id];
    if (!found) continue;
    const o: HeapObject =
      found.kind === "object" && found.type === "Object"
        ? { kind: "map", type: "Object", entries: (found.fields ?? []).map(([k, v]): [TraceValue, TraceValue] => [{ kind: "value", text: JSON.stringify(k), type: "string" }, v]), ...(found.omitted ? { omitted: found.omitted } : {}) }
        : found;
    const n = base(name);
    const items = o.items ?? [];
    const omitted = o.omitted ?? 0;
    // queue.Queue and friends keep their elements in a field.
    if (o.kind === "object" && /^(Queue|LifoQueue|PriorityQueue|SimpleQueue)$/.test(o.type)) {
      const inner = step.heap[refId(fieldOf(o, "queue")) ?? ""];
      if (inner?.kind === "sequence") {
        consumed.add(id);
        consumed.add(refId(fieldOf(o, "queue"))!);
        const it = inner.items ?? [];
        if (o.type === "LifoQueue") out.push({ kind: "stack", id: refId(fieldOf(o, "queue"))!, name, type: o.type, items: it, omitted: inner.omitted ?? 0, topFirst: false });
        else if (o.type === "PriorityQueue") {
          const qid = refId(fieldOf(o, "queue"))!;
          const root = arrayTree(qid, it, false, false);
          out.push(root ? { kind: "tree", id: qid, name, type: o.type, variant: "heap", root, pointers: new Map(), items: it, heapOrder: heapOrder(it) } : { kind: "array", id: qid, name, type: o.type, items: it, omitted: 0, pointers: new Map(), label: "Priority queue" });
        }
        else out.push({ kind: "queue", id: refId(fieldOf(o, "queue"))!, name, type: o.type, items: it, omitted: inner.omitted ?? 0, deque: false });
      }
      continue;
    }
    if (o.kind === "map") {
      const g = GRAPH_NAME.test(n) || !MAP_TYPES.test(o.type) ? null : graphFrom(step, id, name, hints, o);
      if (g || GRAPH_NAME.test(n)) {
        const graph = g ?? graphFrom(step, id, name, hints, o);
        if (graph) {
          consumed.add(id);
          (o.entries ?? []).forEach(([, v]) => refId(v) && consumed.add(refId(v)!));
          out.push(graph);
          continue;
        }
      }
      consumed.add(id);
      out.push({ kind: "hash", id, name, type: o.type, entries: o.entries ?? [], omitted, ordered: ORDERED.test(o.type) || o.type === "LinkedHashMap" || o.type === "Object" });
      continue;
    }
    if (o.kind === "object") {
      // Only objects a variable holds directly; objects inside others show in their owner's fields.
      if (step.frames.some((f) => f.locals.some(([, v]) => v.kind === "ref" && v.id === id))) {
        consumed.add(id);
        out.push({ kind: "object", id, name, type: o.type, fields: o.fields ?? [], omitted });
      }
      continue;
    }
    if (o.kind !== "sequence") continue;
    if (SET_TYPES.test(o.type)) {
      consumed.add(id);
      out.push({ kind: "set", id, name, type: o.type, items, omitted, ordered: ORDERED.test(o.type) || o.type === "LinkedHashSet" });
      continue;
    }
    if (concept === "heap" || HEAP_TYPES.test(o.type) || (!concept && HEAP_NAME.test(n) && !QUEUE_TYPES.test(o.type))) {
      consumed.add(id);
      const root = arrayTree(id, items, false, false);
      if (root) out.push({ kind: "tree", id, name, type: o.type, variant: "heap", root, pointers: new Map(), items, heapOrder: heapOrder(items) });
      else out.push({ kind: "array", id, name, type: o.type, items, omitted, pointers: new Map(), label: HEAP_TYPES.test(o.type) ? "Priority queue" : "Heap" });
      continue;
    }
    if (concept === "stack" || (!concept && (STACK_TYPES.test(o.type) || STACK_NAME.test(n)))) {
      consumed.add(id);
      const topFirst = /^(ArrayDeque|LinkedList|LinkedBlockingDeque|ConcurrentLinkedDeque)$/.test(o.type);
      out.push({ kind: "stack", id, name, type: o.type, items: topFirst ? [...items].reverse() : items, omitted, topFirst });
      continue;
    }
    if (concept === "queue" || QUEUE_TYPES.test(o.type) || QUEUE_NAME.test(n)) {
      consumed.add(id);
      out.push({ kind: "queue", id, name, type: o.type, items, omitted, deque: /deque|^dq$/i.test(n) || (/Deque|deque/.test(o.type) && !QUEUE_NAME.test(n)) });
      continue;
    }
    // Lists of lists: a graph, a matrix, or neither.
    const rows = items.map((x) => step.heap[refId(x) ?? ""]);
    if (items.length > 0 && rows.every((r) => r?.kind === "sequence")) {
      const g = graphFrom(step, id, name, hints, o);
      if (g) {
        consumed.add(id);
        items.forEach((x) => consumed.add(refId(x)!));
        out.push(g);
        continue;
      }
      if (rows.every((r) => (r!.items ?? []).every(isScalar))) {
        if (fromField) continue;
        consumed.add(id);
        items.forEach((x) => consumed.add(refId(x)!));
        const locals = scalarLocals(step).filter(([, v]) => /^-?\d+$/.test(v.text));
        const rowAt = new Map<number, string[]>();
        const colAt = new Map<number, string[]>();
        let r = -1;
        let c = -1;
        for (const [name2, v] of locals) {
          const k = Number(v.text);
          if (ROW_NAME.test(name2) && k >= 0 && k < rows.length) {
            rowAt.set(k, [...(rowAt.get(k) ?? []), name2]);
            if (r < 0) r = k;
          }
          if (COL_NAME.test(name2) && k >= 0) {
            colAt.set(k, [...(colAt.get(k) ?? []), name2]);
            if (c < 0) c = k;
          }
        }
        out.push({ kind: "matrix", id, name, type: o.type, rows: items.map((x) => ({ id: refId(x)!, items: step.heap[refId(x)!]!.items ?? [] })), cell: r >= 0 && c >= 0 ? [r, c] : undefined, rowPointers: rowAt, colPointers: colAt });
        continue;
      }
    }
    if (SEGMENT_NAME.test(n) && items.length >= 3 && items.every((x) => asNumber(x) !== null || isNull(x))) {
      consumed.add(id);
      const oneBased = asNumber(items[0]) === 0 || isNull(items[0]);
      const root = arrayTree(id, items, oneBased, true);
      if (root) {
        out.push({ kind: "tree", id, name, type: o.type, variant: "segment", root, pointers: new Map(), items });
        continue;
      }
    }
    if (fromField) continue;
    consumed.add(id);
    if (n === "args" && items.length === 0 && o.type === "String[]") continue;
    out.push({ kind: "array", id, name, type: o.type, items, omitted, pointers: indexPointersFor(step, items.length, frameOf(step, id)), ...(FENWICK_NAME.test(n) ? { label: "Fenwick tree (BIT)" } : {}) });
  }

  // Strings walked with index variables (two pointers, palindromes): drawn as character arrays.
  const top = step.frames.length - 1;
  const indexed = out.some((x) => x.kind === "matrix" || (x.kind === "array" && x.pointers.size > 0));
  if (top >= 0 && !indexed) {
    for (const [n, v] of step.frames[top]!.locals) {
      if (v.kind !== "value" || !/^(str|String)$/.test(v.type)) continue;
      const text = scalarText(v) ?? "";
      if (text.length < 2 || text.length > 40) continue;
      const pointers = indexPointersFor(step, text.length, top);
      if (pointers.size === 0) continue;
      out.push({
        kind: "array",
        id: `str:${n}`,
        name: n,
        type: v.type,
        items: [...text].map((ch) => ({ kind: "value", text: `'${ch}'`, type: "char" })),
        omitted: 0,
        pointers,
        chars: true,
      });
    }
  }

  const all = [...nodes, ...out];
  for (const s of all) if (s.kind === "graph") annotateGraph(step, s, out);
  return { structures: all, consumed };
}

/** Short title for a structure, as a textbook would name it. */
export function structureTitle(s: Structure): string {
  switch (s.kind) {
    case "array":
      return s.label ?? (s.chars ? "String" : "Array");
    case "matrix":
      return "2D array";
    case "stack":
      return "Stack";
    case "queue":
      return s.deque ? "Deque" : "Queue";
    case "hash":
      return s.type === "Object" ? "Object" : s.ordered && /Tree/.test(s.type) ? "Sorted map" : "Hash map";
    case "set":
      return s.ordered && /Tree/.test(s.type) ? "Sorted set" : "Hash set";
    case "list":
      return { singly: "Singly linked list", doubly: "Doubly linked list", circular: "Circular linked list", "circular-doubly": "Circular doubly linked list" }[s.variant];
    case "tree":
      return {
        binary: "Binary tree",
        bst: "Binary search tree",
        avl: "AVL tree",
        "red-black": "Red-black tree",
        ternary: "Ternary tree",
        "n-ary": "N-ary tree",
        trie: "Trie",
        heap: s.heapOrder === "max" ? "Max-heap" : s.heapOrder === "min" ? "Min-heap" : "Heap",
        segment: "Segment tree",
      }[s.variant];
    case "graph":
      return s.directed ? "Directed graph" : "Graph";
    case "object":
      return `${s.type} object`;
  }
}
