import type { HeapObject, Trace, TraceFrame, TraceStep, TraceValue } from "@cw/shared";

/**
 * Pure helpers behind the visualizer: how to lay out a step's objects, and
 * what changed between two recorded steps. Everything here is derived from
 * the recorded trace; nothing is inferred from source code.
 */

/** Stable text for comparing a value between steps. */
export function valueKey(v: TraceValue | undefined): string {
  return !v ? "" : v.kind === "value" ? `v:${v.text}` : `r:${v.id}`;
}

const CALLABLE_TYPES = new Set(["function", "method", "class", "module", "builtin_function_or_method"]);

/** Functions, methods and classes: drawn inline in their variable rather than as a box. */
export function isCallable(o: HeapObject | undefined): boolean {
  return !!o && o.kind === "other" && CALLABLE_TYPES.has(o.type);
}

/** References held by an object, in drawing order (map keys before their values). */
export function childRefs(o: HeapObject | undefined): string[] {
  if (!o) return [];
  const out: string[] = [];
  const add = (v: TraceValue | undefined) => v?.kind === "ref" && out.push(v.id);
  o.items?.forEach(add);
  o.entries?.forEach(([k, v]) => (add(k), add(v)));
  o.fields?.forEach(([, v]) => add(v));
  return out;
}

export interface Placement {
  id: string;
  /** 0-based grid row and column. */
  row: number;
  col: number;
}

/**
 * Places objects on a grid: roots (reached from variables) start new rows in
 * column 0, an object's first child continues its row one column to the right,
 * and further children open rows below. A linked list therefore reads left to
 * right on one row, and a tree branches downwards.
 */
export function layoutHeap(step: TraceStep, hidden: (id: string) => boolean = () => false): Placement[] {
  const placed = new Map<string, Placement>();
  let nextRow = 0;
  const visible = (id: string) => !!step.heap[id] && !hidden(id) && !placed.has(id);

  const place = (id: string, row: number, col: number) => {
    placed.set(id, { id, row, col });
    nextRow = Math.max(nextRow, row + 1);
    let first = true;
    for (const child of childRefs(step.heap[id])) {
      if (!visible(child)) continue;
      place(child, first ? row : nextRow, col + 1);
      first = false;
    }
  };

  for (const frame of step.frames) {
    const values = frame.locals.map(([, v]) => v);
    if (frame.returnValue) values.push(frame.returnValue);
    for (const v of values) if (v.kind === "ref" && visible(v.id)) place(v.id, nextRow, 0);
  }
  return [...placed.values()];
}

// -- Describing values

const MAX_PREVIEW = 48;

function clip(s: string): string {
  return s.length > MAX_PREVIEW ? `${s.slice(0, MAX_PREVIEW - 1)}…` : s;
}

/** Short text for a value, e.g. `9`, `[1, 2, 5]`, `Node(value=1, …)`, `function square(x)`. */
export function preview(step: TraceStep, v: TraceValue | undefined, depth = 0): string {
  if (!v) return "";
  if (v.kind === "value") return v.text;
  const o = step.heap[v.id];
  if (!o) return "…";
  if (o.kind === "other") return isCallable(o) ? `${o.type} ${o.text?.replace(/^(class|bound method) /, "") ?? ""}`.trim() : (o.text ?? o.type);
  if (depth > 0) return o.kind === "object" ? (o.type === "Object" ? "{…}" : o.type) : o.kind === "map" ? "{…}" : "[…]";
  const more = o.omitted ? ", …" : "";
  if (o.kind === "sequence") return clip(`[${(o.items ?? []).map((x) => preview(step, x, 1)).join(", ")}${more}]`);
  if (o.kind === "map") return clip(`{${(o.entries ?? []).map(([k, x]) => `${preview(step, k, 1)}: ${preview(step, x, 1)}`).join(", ")}${more}}`);
  // JavaScript's plain objects read as literals: {id: 2, tags: […]}.
  if (o.type === "Object") return clip(`{${(o.fields ?? []).map(([n, x]) => `${n}: ${preview(step, x, 1)}`).join(", ")}${more}}`);
  return clip(`${o.type}(${(o.fields ?? []).map(([n, x]) => `${n}=${preview(step, x, 1)}`).join(", ")}${more})`);
}

/**
 * The name a reader would use for an object: the innermost variable holding
 * it (`arr`), else a path through another object (`head.next`), else its type.
 */
export function nameOf(step: TraceStep, id: string): string {
  for (let i = step.frames.length - 1; i >= 0; i--) {
    const hit = step.frames[i]!.locals.find(([, v]) => v.kind === "ref" && v.id === id);
    if (hit) return hit[0];
  }
  // One or two hops through other objects' fields, map values or list slots.
  const seen = new Set<string>([id]);
  const find = (target: string, hops: number): string | null => {
    for (const [pid, o] of Object.entries(step.heap)) {
      if (seen.has(pid)) continue;
      const via =
        o.fields?.find(([, v]) => v.kind === "ref" && v.id === target)?.[0] ??
        (() => {
          const i = o.items?.findIndex((v) => v.kind === "ref" && v.id === target) ?? -1;
          if (i >= 0) return `[${i}]`;
          const e = o.entries?.find(([, v]) => v.kind === "ref" && v.id === target);
          return e ? `[${preview(step, e[0], 1)}]` : null;
        })();
      if (via === null) continue;
      const suffix = via.startsWith("[") ? via : `.${via}`;
      for (let f = step.frames.length - 1; f >= 0; f--) {
        const hit = step.frames[f]!.locals.find(([, v]) => v.kind === "ref" && v.id === pid);
        if (hit) return hit[0] + suffix;
      }
      if (hops > 0) {
        seen.add(pid);
        const parent = find(pid, hops - 1);
        if (parent) return parent + suffix;
      }
    }
    return null;
  };
  return find(id, 1) ?? step.heap[id]?.type ?? "object";
}

// -- What changed between two steps

export type Tone = "call" | "return" | "assign" | "mutate" | "print" | "exception";

/** One sentence of narration. Code parts are rendered in the code font. */
export interface Change {
  tone: Tone;
  parts: (string | { code: string })[];
}

export interface StepDiff {
  changes: Change[];
  /** Keys of things to highlight: `var:<frame>:<name>`, `cell:<id>:<index>`, `key:<id>:<key>`, `field:<id>:<name>`, `obj:<id>`. */
  highlights: Set<string>;
  /** The previous value of a changed slot (same keys as `highlights`), as short text. */
  before: Map<string, string>;
  /** Sequence elements that swapped places, by object id. */
  swaps: Map<string, [number, number]>;
  /** Frames (by index) that appeared with this step. */
  newFrames: Set<number>;
  /** Output printed by the line that just ran. */
  printed: string;
  /** Line that ran to reach this step, in the file of the frame it ran in. */
  ranLine: { file: string; line: number } | null;
}

const code = (s: string) => ({ code: s });

function frameCall(step: TraceStep, f: TraceFrame): string {
  const args = f.locals.map(([n, v]) => `${n}=${preview(step, v, 1)}`).join(", ");
  return clip(`${f.name}(${args})`);
}

/** Number of leading frames that are the same activation in both steps. */
function commonFrames(prev: TraceStep, cur: TraceStep): number {
  // A frame whose `return` event was the previous step is gone now, even if the
  // same function is called again at the same depth.
  const survivors = prev.frames.length - (prev.event === "return" ? 1 : 0);
  let n = Math.min(survivors, cur.frames.length);
  for (let i = 0; i < n; i++) {
    if (prev.frames[i]!.name !== cur.frames[i]!.name) {
      n = i;
      break;
    }
  }
  return n;
}

function diffSequence(id: string, name: string, a: TraceValue[], b: TraceValue[], out: StepDiff, prev: TraceStep, cur: TraceStep) {
  const ka = a.map(valueKey);
  const kb = b.map(valueKey);
  if (ka.length === kb.length) {
    const changed = kb.flatMap((k, i) => (k !== ka[i] ? [i] : []));
    if (changed.length === 0) return;
    changed.forEach((i) => out.highlights.add(`cell:${id}:${i}`));
    const [i, j] = changed;
    if (changed.length === 2 && kb[i!] === ka[j!] && kb[j!] === ka[i!]) {
      out.swaps.set(id, [i!, j!]);
      out.changes.push({ tone: "mutate", parts: ["Swapped ", code(`${name}[${i}]`), " and ", code(`${name}[${j}]`)] });
      return;
    }
    changed.forEach((k) => out.before.set(`cell:${id}:${k}`, preview(prev, a[k], 1)));
    for (const k of changed.slice(0, 3)) {
      out.changes.push({ tone: "mutate", parts: [code(`${name}[${k}]`), " = ", code(preview(cur, b[k], 1)), ` (was ${preview(prev, a[k], 1)})`] });
    }
    return;
  }
  if (kb.length > ka.length && ka.every((k, i) => k === kb[i])) {
    const added = b.slice(ka.length);
    added.forEach((_, n) => out.highlights.add(`cell:${id}:${ka.length + n}`));
    out.changes.push({ tone: "mutate", parts: ["Added ", code(clip(added.map((x) => preview(cur, x, 1)).join(", "))), " to ", code(name)] });
    return;
  }
  if (kb.length < ka.length && kb.every((k, i) => k === ka[i])) {
    out.changes.push({ tone: "mutate", parts: ["Removed ", code(clip(a.slice(kb.length).map((x) => preview(prev, x, 1)).join(", "))), " from ", code(name)] });
    return;
  }
  kb.forEach((k, i) => k !== ka[i] && out.highlights.add(`cell:${id}:${i}`));
  out.changes.push({ tone: "mutate", parts: [code(name), " is now ", code(preview(cur, { kind: "ref", id }))] });
}

function diffObject(id: string, a: HeapObject, b: HeapObject, out: StepDiff, prev: TraceStep, cur: TraceStep) {
  const name = nameOf(cur, id);
  if (b.kind === "sequence") return diffSequence(id, name, a.items ?? [], b.items ?? [], out, prev, cur);
  if (b.kind === "map") {
    const before = new Map((a.entries ?? []).map(([k, v]) => [valueKey(k), v]));
    const after = new Set<string>();
    for (const [k, v] of b.entries ?? []) {
      const kk = valueKey(k);
      after.add(kk);
      const old = before.get(kk);
      if (old && valueKey(old) === valueKey(v)) continue;
      out.highlights.add(`key:${id}:${kk}`);
      if (old) out.before.set(`key:${id}:${kk}`, preview(prev, old, 1));
      out.changes.push({
        tone: "mutate",
        parts: [code(`${name}[${preview(cur, k, 1)}]`), " = ", code(preview(cur, v, 1)), ...(old ? [` (was ${preview(prev, old, 1)})`] : [])],
      });
    }
    for (const [kk, v] of before) {
      if (after.has(kk)) continue;
      const k = (a.entries ?? []).find(([x]) => valueKey(x) === kk)![0];
      out.changes.push({ tone: "mutate", parts: ["Removed ", code(`${name}[${preview(prev, k, 1)}]`), ` (was ${preview(prev, v, 1)})`] });
    }
    return;
  }
  if (b.kind === "object") {
    const before = new Map(a.fields ?? []);
    for (const [f, v] of b.fields ?? []) {
      const old = before.get(f);
      if (old && valueKey(old) === valueKey(v)) continue;
      out.highlights.add(`field:${id}:${f}`);
      if (old) out.before.set(`field:${id}:${f}`, preview(prev, old, 1));
      out.changes.push({ tone: "mutate", parts: [code(`${name}.${f}`), " = ", code(preview(cur, v, 1))] });
    }
  }
}

/**
 * The line that ran to get from `prev` to the next step: the innermost frame's
 * line, or after a `return` event the caller's line that was waiting on it.
 */
export function ranLine(prev: TraceStep): { file: string; line: number } | null {
  const f = prev.frames[prev.frames.length - (prev.event === "return" ? 2 : 1)];
  return f?.file ? { file: f.file, line: f.line } : null;
}

/** What running one line did: calls, returns, assignments, mutations, output, exceptions. */
export function diffSteps(trace: Trace, index: number): StepDiff {
  const cur = trace.steps[index]!;
  const prev = index > 0 ? trace.steps[index - 1] : undefined;
  const out: StepDiff = { changes: [], highlights: new Set(), before: new Map(), swaps: new Map(), newFrames: new Set(), printed: "", ranLine: null };
  const top = cur.frames[cur.frames.length - 1];

  if (cur.event === "exception") out.changes.push({ tone: "exception", parts: [cur.exception ?? "Exception raised"] });
  if (cur.event === "return" && top && cur.frames.length === 1) {
    out.changes.push({ tone: "return", parts: ["Program finished"] });
  } else if (cur.event === "return" && top) {
    out.changes.push({ tone: "return", parts: [code(top.name), " returns ", code(top.returnValue ? preview(cur, top.returnValue) : "nothing")] });
  }
  if (!prev) {
    cur.frames.forEach((_, i) => out.newFrames.add(i));
    return out;
  }

  out.ranLine = ranLine(prev);

  const common = commonFrames(prev, cur);
  for (let i = common; i < cur.frames.length; i++) {
    out.newFrames.add(i);
    out.changes.push({ tone: "call", parts: ["Called ", code(frameCall(cur, cur.frames[i]!))] });
  }

  for (let i = 0; i < common; i++) {
    const before = new Map(prev.frames[i]!.locals.map(([n, v]) => [n, v]));
    for (const [n, v] of cur.frames[i]!.locals) {
      const old = before.get(n);
      if (old && valueKey(old) === valueKey(v)) continue;
      out.highlights.add(`var:${i}:${n}`);
      if (old) out.before.set(`var:${i}:${n}`, preview(prev, old, 1));
      const obj = v.kind === "ref" ? cur.heap[v.id] : undefined;
      // Defining a function or class is noise next to the program's data.
      if (isCallable(obj) && !old) continue;
      out.changes.push({ tone: "assign", parts: [code(n), " = ", code(preview(cur, v)), ...(old && old.kind === "value" && v.kind === "value" ? [` (was ${old.text})`] : [])] });
    }
  }

  for (const [id, b] of Object.entries(cur.heap)) {
    const a = prev.heap[id];
    if (!a) {
      out.highlights.add(`obj:${id}`);
      continue;
    }
    if (a.kind === b.kind && a.type === b.type && !isCallable(b)) diffObject(id, a, b, out, prev, cur);
  }

  if (cur.stdoutLength > prev.stdoutLength) {
    out.printed = trace.stdout.slice(prev.stdoutLength, cur.stdoutLength);
    const shown = out.printed.replace(/\n$/, "");
    out.changes.push({ tone: "print", parts: ["Printed ", code(clip(shown.replace(/\n/g, "⏎ ")))] });
  }
  return out;
}

/**
 * An id per function activation for every step, so a frame keeps its identity
 * while it runs and a new call at the same depth (recursion) is a new frame.
 */
export function frameIds(trace: Trace): string[][] {
  let counter = 0;
  const out: string[][] = [];
  trace.steps.forEach((s, i) => {
    const prev = i > 0 ? trace.steps[i - 1] : undefined;
    const keep = prev ? commonFrames(prev, s) : 0;
    out.push(s.frames.map((_, f) => (f < keep ? out[i - 1]![f]! : `f${counter++}`)));
  });
  return out;
}

// -- Index pointers

const INDEX_NAME = /^(i|j|k|l|r|lo|low|hi|high|mid|left|right|start|end|begin|pos|idx|index|ptr|p|q|slow|fast|front|rear|top)$|(Index|Idx|_idx|_index|_pos)$/;
const INT_TYPES = new Set(["int", "long", "short", "byte", "Integer", "Long", "Short", "number", "unsigned int", "long long", "size_t", "unsigned long"]);

/**
 * Integer variables with index-like names (`i`, `j`, `lo`, `mid`…) that are a
 * valid index into a list or array the same frame holds, drawn under that
 * element. For each sequence the innermost frame referencing it wins.
 */
export function indexPointers(step: TraceStep): Map<string, Map<number, string[]>> {
  const out = new Map<string, Map<number, string[]>>();
  for (let f = step.frames.length - 1; f >= 0; f--) {
    const locals = step.frames[f]!.locals;
    const indices = locals.filter(([n, v]) => v.kind === "value" && INT_TYPES.has(v.type) && INDEX_NAME.test(n) && /^-?\d+$/.test(v.text));
    if (indices.length === 0) continue;
    for (const [, v] of locals) {
      if (v.kind !== "ref" || out.has(v.id)) continue;
      const o = step.heap[v.id];
      if (o?.kind !== "sequence" || !o.items) continue;
      const at = new Map<number, string[]>();
      for (const [n, x] of indices) {
        const i = Number((x as { text: string }).text);
        if (i >= 0 && i < o.items.length) at.set(i, [...(at.get(i) ?? []), n]);
      }
      if (at.size > 0) out.set(v.id, at);
    }
  }
  return out;
}

/** Markers for the timeline: call depth per step, where output was printed and where exceptions happened. */
export function timeline(trace: Trace): { depth: number[]; printed: number[]; exceptions: number[]; maxDepth: number } {
  const depth: number[] = [];
  const printed: number[] = [];
  const exceptions: number[] = [];
  trace.steps.forEach((s, i) => {
    depth.push(s.frames.length);
    if (i > 0 && s.stdoutLength > trace.steps[i - 1]!.stdoutLength) printed.push(i);
    if (s.event === "exception") exceptions.push(i);
  });
  return { depth, printed, exceptions, maxDepth: Math.max(1, ...depth) };
}

/**
 * Java nested classes reach the tracer by their binary names (`Main$Node`).
 * Show the name written in the source (`Node`); anonymous classes (`Main$1`)
 * keep their full name, which is the only one they have.
 */
export function sourceTypeName(type: string): string {
  const last = type.slice(type.lastIndexOf("$") + 1);
  return last && !/^\d/.test(last) ? last : type;
}

/** The trace with nested Java class names as written in the source. */
export function withSourceTypeNames(trace: Trace): Trace {
  if (!trace.steps.some((s) => Object.values(s.heap).some((o) => o.type.includes("$")))) return trace;
  return {
    ...trace,
    steps: trace.steps.map((step) => ({
      ...step,
      heap: Object.fromEntries(Object.entries(step.heap).map(([id, o]) => [id, o.type.includes("$") ? { ...o, type: sourceTypeName(o.type) } : o])),
    })),
  };
}


// -- Where the logic starts

const CONSTRUCTOR = new Set(["__init__", "__new__", "__post_init__", "<init>", "<clinit>", "constructor", "initialize", "__construct"]);

/** A call that only makes an object: a constructor, an initializer, or a class being defined. */
function makesAnObject(name: string, types: ReadonlySet<string>): boolean {
  // Ruby: a class body (`<class:Node>`), and a required file's top level, which defines things.
  if (/^<class:|^<module:|^<top \(required\)>$/.test(name)) return true;
  const parts = name.split(/[.:#\s]+|->/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  // `Node::Node`, `Node.__init__`, `Node.<init>`, `Node#initialize`, `Node->__construct`; JavaScript names a constructor after its class.
  return CONSTRUCTOR.has(last) || (parts.length > 1 && last === parts[parts.length - 2]) || types.has(name) || types.has(last);
}

const objectCount = (step: TraceStep) => Object.values(step.heap).filter((o) => o.kind === "object").length;

/**
 * The step at which the program stops preparing its data and starts working
 * on it. Before it the program only declares things, in a straight line:
 * variables, arrays, nodes linked by hand, objects made in a loop. The first
 * call to one of the program's own functions, or the first loop that does
 * anything else, is where its logic begins. 0 when there is no such start
 * worth skipping to (a program with no loops or calls, or hardly any setup).
 */
export function logicStart(trace: Trace): number {
  const steps = trace.steps;
  const base = steps[0]?.frames.length ?? 0;
  if (!base) return 0;
  const types = new Set<string>();
  for (const s of steps) for (const o of Object.values(s.heap)) if (o.kind === "object") types.add(o.type);

  /** A call from the outermost function into one of the program's own (not a constructor). */
  const callsOwnCode = (s: TraceStep) => s.frames.length > base && !makesAnObject(s.frames[base]!.name, types);
  /** Steps in the outermost function, by line. */
  const lineAt = (i: number) => (steps[i]!.frames.length === base && steps[i]!.event === "line" ? steps[i]!.frames[base - 1]!.line : null);

  let start = -1;
  let lastOuter = 0;
  const firstSeen = new Map<number, number>();
  for (let i = 0; i < steps.length && start < 0; i++) {
    if (callsOwnCode(steps[i]!)) {
      // The line that makes the call.
      start = lastOuter;
      break;
    }
    const line = lineAt(i);
    if (line === null) continue;
    // Back on the line that made a call (a constructor's), to finish it: the same visit, not a second one.
    const back = lastOuter !== i - 1 && lineAt(lastOuter) === line;
    lastOuter = i;
    const first = firstSeen.get(line);
    if (first === undefined || back) {
      if (first === undefined) firstSeen.set(line, i);
      continue;
    }
    // A line run again: a loop, from `first`. It ends at the first later line below everything the loop has run.
    let bottom = line;
    for (let k = first; k <= i; k++) bottom = Math.max(bottom, lineAt(k) ?? 0);
    let end = i + 1;
    let own = false;
    for (; end < steps.length; end++) {
      if (callsOwnCode(steps[end]!)) own = true;
      const l = lineAt(end);
      if (l === null) continue;
      if (l < line || l > bottom) {
        // Still inside it when a longer body shows itself (a branch not taken before).
        if (l > bottom && [...firstSeen.keys()].every((seen) => seen !== l) && steps.slice(end + 1).some((_, k) => lineAt(end + 1 + k) === line)) {
          bottom = l;
          continue;
        }
        break;
      }
    }
    // A loop that only makes objects (the nodes of a list, the rows of a table) is still setup.
    const made = objectCount(steps[Math.min(end, steps.length - 1)]!) - objectCount(steps[first]!);
    if (own || made < 2) start = first;
    else {
      for (let k = first; k < end; k++) {
        const l = lineAt(k);
        if (l !== null && !firstSeen.has(l)) firstSeen.set(l, k);
      }
      i = end - 1;
      lastOuter = i;
    }
  }
  // Nothing to skip to, or too little skipped to be worth it.
  return start >= 3 && start < steps.length - 1 ? start : 0;
}
