/**
 * Execution trace for the visualizer. Recorded inside the sandbox by a
 * language-specific tracer that single-steps the real program (CPython's
 * sys.settrace, or JDI stepping on the JVM) and snapshots every frame and
 * every object reachable from them at each line. Nothing is inferred from
 * source code.
 */

/** A value in a variable, field or container slot. */
export type TraceValue =
  /** Numbers, booleans, null/None, characters and strings: shown inline. */
  | { kind: "value"; text: string; type: string }
  /** A reference to an object in the step's heap. */
  | { kind: "ref"; id: string };

export interface HeapObject {
  /** Drawing style. `sequence` covers Python lists/tuples/sets and Java arrays/collections. */
  kind: "sequence" | "map" | "object" | "other";
  /** Type name as the language prints it, e.g. `list`, `int[]`, `HashMap`, `Point`. */
  type: string;
  /** `sequence`: elements in order. */
  items?: TraceValue[];
  /** `map`: key/value pairs. */
  entries?: [TraceValue, TraceValue][];
  /** `object`: named fields. */
  fields?: [string, TraceValue][];
  /** `other`: a short description (functions, classes, modules, unexpandable objects). */
  text?: string;
  /** Number of elements/entries/fields left out because of size limits. */
  omitted?: number;
}

export interface TraceFrame {
  /** Function or method, e.g. `square`, `Point.dist`, `<module>`, `Main.main`. */
  name: string;
  file: string;
  line: number;
  /** Parameters and locals in declaration order. */
  locals: [string, TraceValue][];
  /** Set on the step where this frame returns. */
  returnValue?: TraceValue;
}

export interface TraceStep {
  /** `line`: about to run this line. `return`: the top frame is returning. `exception`: an exception is propagating. */
  event: "line" | "return" | "exception";
  /** Call stack, outermost (e.g. `<module>` / `main`) first. The last frame is where execution is. */
  frames: TraceFrame[];
  /** Objects reachable from the frames at this step, by id. */
  heap: Record<string, HeapObject>;
  /** Characters of `Trace.stdout` printed before this step. */
  stdoutLength: number;
  /** `exception` steps: e.g. `ZeroDivisionError: division by zero`. */
  exception?: string;
}

export interface Trace {
  language: string;
  steps: TraceStep[];
  /** Everything the program printed to stdout while traced. */
  stdout: string;
  /** Why recording ended early, if it did (step or size limit, or a timeout). */
  truncated?: string;
}

export const TRACE_LIMITS = {
  /** Steps recorded before tracing stops (the program keeps running untraced). */
  maxSteps: 1000,
  /** Heap objects captured per step. */
  maxObjectsPerStep: 200,
  /** Elements, entries or fields captured per object. */
  maxItemsPerObject: 100,
  /** Characters kept of a string value. */
  maxStringChars: 200,
  /** Largest serialized trace accepted by the worker. */
  maxTraceBytes: 8 * 1024 * 1024,
} as const;
