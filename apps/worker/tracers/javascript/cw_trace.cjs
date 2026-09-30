"use strict";
/**
 * Code Workspace JavaScript/TypeScript execution tracer (visualizer).
 *
 * Runs the program in this Node process while a worker thread, connected to
 * this thread's inspector, pauses at every statement in a project file and
 * records the call stack with each frame's variables and every object
 * reachable from them. Everything outside the project (Node internals, this
 * file) is blackboxed, so stepping never stops there. The trace is written as
 * JSON when the program ends. Stdin, stdout and stderr are untouched apart
 * from counting stdout characters.
 *
 *     node [flags] cw_trace.cjs <config.json>
 *
 * config: {"entry", "root", "files", "out", "limits": {...}}
 *
 * Objects are read through own data properties and built-in iterators
 * (Map.prototype.entries...), never through getters, proxies or toString, so
 * recording cannot change what the program does.
 */

const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { types } = require("node:util");

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const L = config.limits;

// -- Stdout: counted and kept, passed through unchanged.

let stdoutCount = 0;
let kept = "";
const KEEP = 1_000_000;
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function write(chunk, encoding, cb) {
  const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
  stdoutCount += s.length;
  if (kept.length < KEEP) kept += s.slice(0, KEEP - kept.length);
  return realWrite(chunk, encoding, cb);
};

// -- Snapshots, taken on this thread while it is paused (called by the worker through the inspector).

const ids = new WeakMap();
let nextId = 1;
let heap = null;
let queue = [];

const idOf = (o) => {
  let id = ids.get(o);
  if (!id) {
    id = String(nextId++);
    ids.set(o, id);
  }
  return id;
};

const own = (o, k) => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d && "value" in d ? { ok: true, v: d.value } : { ok: false };
};

function typeName(o) {
  if (typeof o === "function") return /^class[\s{]/.test(Function.prototype.toString.call(o)) ? "class" : "function";
  const proto = Object.getPrototypeOf(o);
  if (proto === null) return "Object";
  const ctor = own(proto, "constructor");
  return (ctor.ok && typeof ctor.v === "function" && ctor.v.name) || "Object";
}

function clip(s) {
  return s.length > L.maxStringChars ? `${s.slice(0, L.maxStringChars)}…` : s;
}

function value(v) {
  switch (typeof v) {
    case "number":
      return { kind: "value", text: Object.is(v, -0) ? "-0" : String(v), type: "number" };
    case "string":
      return { kind: "value", text: JSON.stringify(clip(v)), type: "string" };
    case "boolean":
      return { kind: "value", text: String(v), type: "boolean" };
    case "undefined":
      return { kind: "value", text: "undefined", type: "undefined" };
    case "bigint":
      return { kind: "value", text: `${v}n`, type: "bigint" };
    case "symbol":
      return { kind: "value", text: Symbol.prototype.toString.call(v), type: "symbol" };
    default:
      break;
  }
  if (v === null) return { kind: "value", text: "null", type: "null" };
  const id = idOf(v);
  if (!(id in heap)) {
    if (Object.keys(heap).length >= L.maxObjectsPerStep) return { kind: "value", text: `<${typeName(v)}>`, type: typeName(v) };
    heap[id] = null;
    queue.push(v);
  }
  return { kind: "ref", id };
}

function trim(obj, total, shown) {
  if (total > shown) obj.omitted = total - shown;
  return obj;
}

function signature(fn) {
  const src = Function.prototype.toString.call(fn);
  const name = fn.name || "anonymous";
  const m = /^(?:async\s+)?(?:function\s*\*?\s*[\w$]*\s*)?\(([^)]*)\)/.exec(src) || /^(?:async\s+)?([\w$]+)\s*=>/.exec(src);
  return `${name}(${m ? m[1].replace(/\s+/g, " ").trim() : ""})`;
}

function describe(o) {
  if (typeof o === "function") {
    const t = typeName(o);
    return { kind: "other", type: t, text: t === "class" ? `class ${o.name}` : signature(o) };
  }
  if (types.isProxy(o)) return { kind: "other", type: "Proxy", text: "Proxy" };
  const max = L.maxItemsPerObject;
  if (Array.isArray(o)) {
    const n = o.length;
    const items = [];
    for (let i = 0; i < Math.min(n, max); i++) {
      const d = own(o, String(i));
      items.push(d.ok ? value(d.v) : { kind: "value", text: "empty", type: "undefined" });
    }
    return trim({ kind: "sequence", type: "Array", items }, n, items.length);
  }
  if (ArrayBuffer.isView(o) && !(o instanceof DataView)) {
    const items = [];
    for (let i = 0; i < Math.min(o.length, max); i++) items.push(value(o[i]));
    return trim({ kind: "sequence", type: typeName(o), items }, o.length, items.length);
  }
  if (types.isMap(o)) {
    const entries = [];
    for (const [k, v] of Map.prototype.entries.call(o)) {
      if (entries.length >= max) break;
      entries.push([value(k), value(v)]);
    }
    return trim({ kind: "map", type: "Map", entries }, Reflect.apply(Object.getOwnPropertyDescriptor(Map.prototype, "size").get, o, []), entries.length);
  }
  if (types.isSet(o)) {
    const items = [];
    for (const v of Set.prototype.values.call(o)) {
      if (items.length >= max) break;
      items.push(value(v));
    }
    return trim({ kind: "sequence", type: "Set", items }, Reflect.apply(Object.getOwnPropertyDescriptor(Set.prototype, "size").get, o, []), items.length);
  }
  if (types.isDate(o)) return { kind: "other", type: "Date", text: Number.isNaN(Date.prototype.getTime.call(o)) ? "Invalid Date" : Date.prototype.toISOString.call(o) };
  if (types.isRegExp(o)) return { kind: "other", type: "RegExp", text: RegExp.prototype.toString.call(o) };
  if (types.isNativeError(o)) {
    const name = own(o, "name");
    const msg = own(o, "message");
    return { kind: "other", type: typeName(o), text: `${name.ok ? name.v : typeName(o)}: ${msg.ok ? msg.v : ""}` };
  }
  if (types.isPromise(o)) return { kind: "other", type: "Promise", text: "Promise" };
  if (types.isWeakMap(o) || types.isWeakSet(o) || types.isBoxedPrimitive(o) || types.isGeneratorObject(o)) return { kind: "other", type: typeName(o), text: typeName(o) };
  const keys = Object.keys(o);
  const fields = [];
  let total = 0;
  for (const k of keys) {
    const d = own(o, k);
    if (!d.ok) continue;
    total++;
    if (fields.length < max) fields.push([k, value(d.v)]);
  }
  return trim({ kind: "object", type: typeName(o), fields }, total, fields.length);
}

function drain() {
  while (queue.length) {
    const o = queue.shift();
    heap[idOf(o)] = describe(o);
  }
}

const HIDDEN = new Set(["exports", "require", "module", "__filename", "__dirname"]);

const api = {
  begin() {
    heap = {};
    queue = [];
  },
  /** A scope's variables, in declaration order, as [name, value] pairs. */
  scope(scope, topLevel) {
    const out = [];
    for (const k of Object.keys(scope)) {
      if (topLevel && HIDDEN.has(k)) continue;
      let v;
      try {
        v = scope[k];
      } catch {
        continue; // Not initialised yet (let/const before its line).
      }
      out.push([k, value(v)]);
    }
    return JSON.stringify(out);
  },
  one(v) {
    return JSON.stringify(value(v));
  },
  end() {
    drain();
    const h = heap;
    heap = null;
    return JSON.stringify({ heap: h, stdoutLength: stdoutCount });
  },
};
Object.defineProperty(globalThis, Symbol.for("cw.trace"), { value: api });

// -- The recorder, and the end of the run.

const done = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(path.join(__dirname, "cw_trace_worker.cjs"), {
  workerData: { config, done, root: config.root },
  stdout: false,
  stderr: false,
});
worker.unref();

let finished = false;
/** Asks the recorder to write the trace and waits (at most a few seconds) until it has. */
function finish() {
  if (finished) return;
  finished = true;
  worker.postMessage({ type: "finish", stdout: kept });
  Atomics.wait(done, 0, 0, 5000);
}

const realExit = process.exit.bind(process);
process.exit = (code) => {
  finish();
  realExit(code);
};
process.on("beforeExit", () => {
  finish();
  worker.terminate();
});
/**
 * An uncaught error as Node itself prints it: the line that threw with a
 * caret, the stack (without the tracer's own frames), and the Node version.
 */
function formatError(e) {
  const stack = e && typeof e.stack === "string" ? e.stack : String(e);
  const lines = stack.split("\n").filter((l) => !/cw_trace|at Worker\.<anonymous>|at MessagePort\.|node:internal\/event_target/.test(l));
  let head = "";
  const at = /\((\/[^():]+):(\d+):(\d+)\)|at (\/[^():]+):(\d+):(\d+)/.exec(stack);
  if (at) {
    const [file, line, col] = at[1] ? [at[1], +at[2], +at[3]] : [at[4], +at[5], +at[6]];
    try {
      const code = fs.readFileSync(file, "utf8").split("\n")[line - 1];
      if (code !== undefined && file.startsWith(`${config.root}/`)) head = `${file}:${line}\n${code}\n${" ".repeat(Math.max(0, col - 1))}^\n\n`;
    } catch {}
  }
  return `${head}${lines.join("\n")}\n\nNode.js ${process.version}\n`;
}

process.on("uncaughtException", (e) => {
  process.stderr.write(formatError(e));
  process.exitCode = 1;
  finish();
  worker.terminate();
  realExit(1);
});

const dbg = (s) => process.env.CW_TRACE_DEBUG && fs.writeSync(2, `[main ${Date.now() % 100000}] ${s}
`);
dbg("worker started");
worker.once("message", (m) => {
  dbg(`message ${JSON.stringify(m)}`);
  if (m.type !== "ready") return;
  const entry = path.resolve(config.root, config.entry);
  process.argv = [process.argv[0], entry, ...process.argv.slice(3)];
  if (/\.(mjs|mts)$/.test(entry)) {
    import(require("node:url").pathToFileURL(entry).href).catch((e) => {
      process.stderr.write(formatError(e));
      process.exitCode = 1;
    });
  } else {
    require(entry);
  }
});
worker.ref();
worker.once("message", () => worker.unref());
