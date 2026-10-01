"use strict";
/**
 * Code Workspace JavaScript / TypeScript debug adapter.
 *
 * Runs inside the sandbox. It starts the program as its own Node process with
 * the inspector waiting on loopback, connects to it over the inspector's
 * WebSocket, and speaks newline-delimited JSON on its own stdin/stdout, the
 * same protocol as the Java and Python adapters:
 *
 *   in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
 *        | setBreakpoints | variables | evaluate | terminate
 *   out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}
 *
 * The program keeps its own stdin (the run's input file or the interactive
 * FIFO); its stdout and stderr are relayed as "output" events. Inspecting
 * values never runs program code: children are read as own data properties
 * (getters are not called) and watch expressions are evaluated by V8 with
 * side effects forbidden. TypeScript lines are mapped through the inline
 * source map Node produces when it transforms the file.
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const MAX_CHILDREN = 200;
const MAX_ENTRIES = 100;
const PREVIEW_CHARS = 200;
const THREAD = "main";
/** CommonJS wrapper arguments: always there, never the program's own variables. */
const HIDDEN = new Set(["exports", "require", "module", "__filename", "__dirname"]);

// ------------------------------------------------------------------ protocol

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
/** Exits once everything written so far has gone out. */
const exit = (code) => process.stdout.write("", () => process.exit(code));
const event = (name, body = {}) => send({ type: "event", event: name, ...body });
function respond(seq, success = true, message, body = {}) {
  const msg = { type: "response", requestSeq: seq, success, ...body };
  if (message !== undefined) msg.message = message;
  send(msg);
}

// ------------------------------------------------------------ inspector link

let ws = null;
let nextId = 1;
const waiting = new Map();
const handlers = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject, method });
    if (process.env.CW_DEBUG) process.stderr.write(`send ${id} ${method}
`);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const on = (method, fn) => handlers.set(method, fn);

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(`inspector connection failed: ${e.message || "error"}`));
    ws.onclose = () => {
      for (const w of waiting.values()) w.reject(new Error("the program ended"));
      waiting.clear();
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("utf8"));
      if (msg.id !== undefined) {
        const w = waiting.get(msg.id);
        if (!w) return;
        waiting.delete(msg.id);
        if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
        else w.resolve(msg.result);
        return;
      }
      if (process.env.CW_DEBUG) process.stderr.write(`cdp ${msg.method} ${JSON.stringify(msg.params).slice(0, 300)}
`);
      const fn = handlers.get(msg.method);
      if (fn) {
        Promise.resolve()
          .then(() => fn(msg.params))
          .catch((e) => event("error", { message: `${msg.method}: ${e && e.message ? e.message : e}` }));
      }
    };
  });
}

// --------------------------------------------------------------- the project

let root = "/";
let files = new Set();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let rootUrl = /^$/;
const inProject = (url) => rootUrl.test(url);
const relative = (url) => decodeURIComponent(url.replace(/^file:\/\//, "")).slice(root.length + 1);

/** Script id -> url, and project file -> its script id once loaded. */
const scripts = new Map();
const scriptOf = new Map();
/** Generated line -> [[column, source line]] for scripts Node transformed (TypeScript). */
const sourceMaps = new Map();

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeMappings(mappings) {
  const lines = [];
  let srcLine = 0;
  for (const text of mappings.split(";")) {
    const segs = [];
    let col = 0;
    for (const seg of text ? text.split(",") : []) {
      const v = [];
      let value = 0;
      let shift = 0;
      for (const ch of seg) {
        let d = B64.indexOf(ch);
        const more = d & 32;
        d &= 31;
        value += d << shift;
        if (more) shift += 5;
        else {
          v.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      col += v[0];
      if (v.length >= 4) {
        srcLine += v[2];
        segs.push([col, srcLine]);
      }
    }
    lines.push(segs);
  }
  return lines;
}

/** The 1-based line in the file as written. */
function lineOf(loc) {
  const map = sourceMaps.get(loc.scriptId);
  if (!map) return loc.lineNumber + 1;
  for (let l = loc.lineNumber; l >= 0; l--) {
    const segs = map[l];
    if (!segs || segs.length === 0) continue;
    if (l < loc.lineNumber) return segs[segs.length - 1][1] + 1;
    let best = segs[0];
    for (const seg of segs) if (seg[0] <= loc.columnNumber) best = seg;
    return best[1] + 1;
  }
  return loc.lineNumber + 1;
}

/**
 * The generated-line map of a TypeScript file, worked out before the program
 * loads it with the same transform Node applies (same Node, same options), so
 * its breakpoints can be placed before any of it runs.
 */
const planned = new Map();
let transformTypes = false;
function plannedMap(file) {
  if (!/\.[cm]?ts$/.test(file)) return null;
  if (planned.has(file)) return planned.get(file);
  let map = null;
  try {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const code = require("node:module").stripTypeScriptTypes(source, { mode: transformTypes ? "transform" : "strip", sourceMap: transformTypes });
    const m = /\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;,]+;)?base64,(\S+)/.exec(code);
    if (m) map = decodeMappings(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")).mappings);
  } catch {}
  planned.set(file, map);
  return map;
}

/** Where a written line starts in the generated code: the first mapping onto it. */
function generatedIn(map, line) {
  if (!map) return { lineNumber: line - 1, columnNumber: 0 };
  for (let l = 0; l < map.length; l++) {
    for (const [col, src] of map[l]) if (src === line - 1) return { lineNumber: l, columnNumber: col };
  }
  return null;
}

on("Debugger.scriptParsed", (p) => {
  scripts.set(p.scriptId, p.url);
  if (!inProject(p.url)) return;
  const m = /^data:application\/json;(?:charset=[^;,]+;)?base64,(.*)$/.exec(p.sourceMapURL || "");
  if (m) {
    try {
      sourceMaps.set(p.scriptId, decodeMappings(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")).mappings));
    } catch {}
  }
  scriptOf.set(relative(p.url), p.scriptId);
});

const urlOf = (cf) => cf.url || scripts.get(cf.location.scriptId) || "";
/** Frames of the program itself (not Node's, not compiler-made initialisers). */
const isProjectFrame = (cf) => inProject(urlOf(cf)) && !cf.functionName.startsWith("<");

// ---------------------------------------------------------------- breakpoints

/** Project file -> lines the user set. */
const breakpoints = new Map();
/** Project file -> inspector breakpoint ids set in its script. */
const placed = new Map();
/** Inspector breakpoint id -> the file and line it was asked for (those set before their file was parsed). */
const askedOf = new Map();
/** Project file -> what was last reported for its breakpoints. */
const reported = new Map();

// A breakpoint set before its file was parsed gets its place when the file is: a line
// without code resolves to the next statement, and the editor is told which.
on("Debugger.breakpointResolved", (p) => {
  const asked = askedOf.get(p.breakpointId);
  const report = asked && reported.get(asked.file);
  if (!report) return;
  const actual = lineOf(p.location);
  const entry = report.find((b) => b.line === asked.line);
  if (!entry || actual < asked.line || entry.actual === actual) return;
  entry.verified = true;
  entry.actual = actual;
  event("breakpoints", { file: asked.file, breakpoints: report });
});

async function placeBreakpoints(file) {
  const scriptId = scriptOf.get(file);
  for (const id of placed.get(file) || []) {
    askedOf.delete(id);
    await cdp("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
  }
  placed.delete(file);
  const lines = [...(breakpoints.get(file) || [])].sort((a, b) => a - b);
  const ids = [];
  if (scriptId === undefined || !sourceMaps.has(scriptId)) {
    // By url: V8 places them as it parses the file, before any of it runs.
    const url = `file://${root}/${file.split("/").map(encodeURIComponent).join("/")}`;
    const map = scriptId === undefined ? plannedMap(file) : null;
    const result = [];
    for (const line of lines) {
      const at = generatedIn(map, line);
      if (!at) {
        result.push({ line, verified: false });
        continue;
      }
      try {
        const r = await cdp("Debugger.setBreakpointByUrl", { url, ...at });
        ids.push(r.breakpointId);
        if (scriptId === undefined) askedOf.set(r.breakpointId, { file, line });
        const loc = r.locations[0];
        // A line without code resolves to the next statement: say which, so the editor shows it there.
        const actual = loc ? lineOf(loc) : undefined;
        result.push(scriptId === undefined ? { line, verified: files.has(file) } : loc ? { line, verified: true, ...(actual >= line ? { actual } : {}) } : { line, verified: false });
      } catch {
        result.push({ line, verified: false });
      }
    }
    placed.set(file, ids);
    reported.set(file, result);
    return result;
  }
  const result = [];
  for (const line of lines) {
    const at = generatedIn(sourceMaps.get(scriptId), line);
    if (!at) {
      result.push({ line, verified: false });
      continue;
    }
    try {
      const r = await cdp("Debugger.setBreakpoint", { location: { scriptId, ...at } });
      ids.push(r.breakpointId);
      // A line without code resolves to the next statement: say which, so the editor shows it there.
      const actual = lineOf(r.actualLocation);
      result.push({ line, verified: true, ...(actual >= line ? { actual } : {}) });
    } catch {
      result.push({ line, verified: false });
    }
  }
  placed.set(file, ids);
  reported.set(file, result);
  return result;
}

// ------------------------------------------------------------------- values

function clip(s) {
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS - 1)}…` : s;
}

function quote(s) {
  return JSON.stringify(s.length > 500 ? `${s.slice(0, 500)}…` : s);
}

/** `ƒ square(x)` / `class Point`. */
function functionText(o) {
  const d = (o.description || "").trim();
  if (/^class\b/.test(d)) return `class ${o.className === "Function" ? (/^class\s+([\w$]+)/.exec(d) || [])[1] || "" : ""}`.trim();
  const head = d.split("{")[0].replace(/^(async\s+)?function\*?\s*/, "$1").trim();
  return `ƒ ${head || "anonymous"}`.replace(/\s+/g, " ");
}

/**
 * One property of a preview: `1`, `"a"`, `[…]`, `{…}`. Map and Set entries come
 * as object previews, with the text in `description` instead of `value`.
 */
function previewValue(pv) {
  const p = pv.value === undefined && pv.description !== undefined ? { ...pv, value: pv.description } : pv;
  if (p.type === "string") return JSON.stringify(p.value ?? "");
  if (p.type === "object") {
    if (p.subtype === "null") return "null";
    if (p.subtype === "array") return p.value && /\(0\)$/.test(p.value) ? "[]" : "[…]";
    if (p.subtype === "map" || p.subtype === "set") return p.value || p.subtype;
    if (p.subtype === "date" || p.subtype === "regexp" || p.subtype === "error") return p.value || "";
    return p.value && p.value !== "Object" ? `${p.value} {…}` : "{…}";
  }
  if (p.type === "function") return "ƒ";
  return p.value ?? p.type;
}

function previewText(o) {
  const pv = o.preview;
  if (!pv) return o.description || o.className || "object";
  const more = pv.overflow ? ", …" : "";
  if (o.subtype === "array" || o.subtype === "typedarray") {
    const items = pv.properties.filter((p) => /^\d+$/.test(p.name)).map(previewValue);
    const body = `[${items.join(", ")}${more}]`;
    return o.subtype === "typedarray" ? `${o.className} ${body}` : body;
  }
  if (o.subtype === "map") return `${o.description} {${(pv.entries || []).map((e) => `${previewValue(e.key)} => ${previewValue(e.value)}`).join(", ")}${more}}`;
  if (o.subtype === "set") return `${o.description} {${(pv.entries || []).map((e) => previewValue(e.value)).join(", ")}${more}}`;
  if (["date", "regexp", "error", "promise", "proxy", "weakmap", "weakset", "iterator", "generator", "arraybuffer", "dataview"].includes(o.subtype)) {
    return (o.description || o.className).split("\n")[0];
  }
  const fields = pv.properties.map((p) => `${p.name}: ${previewValue(p)}`).join(", ");
  const cls = o.className && o.className !== "Object" ? `${o.className} ` : "";
  return `${cls}{${fields}${more}}`;
}

function lengthOf(o) {
  const m = /\((\d+)\)/.exec(o.description || "");
  return m ? Number(m[1]) : undefined;
}

let refs = new Map();
let nextRef = 1;
function register(target) {
  const ref = nextRef++;
  refs.set(ref, target);
  return ref;
}

/** The protocol's value: text, type, and a reference when it has children. */
function format(o) {
  switch (o.type) {
    case "undefined":
      return { value: "undefined", type: "undefined", ref: 0 };
    case "string":
      return { value: clip(quote(o.value)), type: "string", ref: 0 };
    case "number":
    case "boolean":
      return { value: o.unserializableValue || String(o.value), type: o.type, ref: 0 };
    case "bigint":
      return { value: o.unserializableValue || o.description, type: "bigint", ref: 0 };
    case "symbol":
      return { value: o.description, type: "symbol", ref: 0 };
    case "function":
      return { value: clip(functionText(o)), type: /^class\b/.test(o.description || "") ? "class" : "function", ref: 0 };
  }
  if (o.subtype === "null") return { value: "null", type: "null", ref: 0 };
  const pv = o.preview;
  const expandable = !pv || pv.overflow || (pv.properties && pv.properties.length > 0) || (pv.entries && pv.entries.length > 0);
  const d = { value: clip(previewText(o)), type: o.className || o.subtype || "object", ref: expandable && o.objectId ? register({ kind: "object", object: o }) : 0 };
  if (["array", "typedarray", "map", "set"].includes(o.subtype)) {
    const n = lengthOf(o);
    if (n !== undefined) d.length = n;
  }
  return d;
}

const describe = (name, o) => ({ name, ...format(o) });

async function properties(objectId) {
  return cdp("Runtime.getProperties", { objectId, ownProperties: true, generatePreview: true });
}

async function children(o) {
  const r = await properties(o.objectId);
  const own = r.result.filter((p) => p.name !== "__proto__" && p.isOwn !== false);
  const out = [];
  if (o.subtype === "map" || o.subtype === "set") {
    const entries = (r.internalProperties || []).find((p) => p.name === "[[Entries]]");
    if (entries && entries.value && entries.value.objectId) {
      const items = (await properties(entries.value.objectId)).result.filter((p) => /^\d+$/.test(p.name));
      for (const item of items.slice(0, MAX_ENTRIES)) {
        const parts = (await properties(item.value.objectId)).result;
        const key = parts.find((p) => p.name === "key");
        const value = parts.find((p) => p.name === "value");
        if (!value) continue;
        out.push(describe(o.subtype === "map" && key ? format(key.value).value : `[${item.name}]`, value.value));
      }
      const total = lengthOf(o) ?? items.length;
      if (total > out.length) out.push({ name: "…", value: `${total - out.length} more`, type: "", ref: 0 });
    }
    return out;
  }
  const list = o.subtype === "array" || o.subtype === "typedarray" ? own.filter((p) => p.name !== "length") : own;
  for (const p of list.slice(0, MAX_CHILDREN)) {
    const name = /^\d+$/.test(p.name) ? `[${p.name}]` : p.name;
    if (p.value) out.push(describe(name, p.value));
    // Accessors are not called: that would run program code.
    else out.push({ name, value: p.get && p.set ? "(getter/setter)" : p.get ? "(getter)" : "(setter)", type: "", ref: 0 });
  }
  if (list.length > MAX_CHILDREN) out.push({ name: "…", value: `${list.length - MAX_CHILDREN} more`, type: "", ref: 0 });
  return out;
}

/** The module wrapper of a CommonJS file, or an ES module's body. */
function isTopLevel(cf) {
  if (cf.functionName) return false;
  // An ES module's body: its own scope is the module scope (a callback inside it has a local scope first).
  const own = cf.scopeChain.find((s) => s.type !== "block" && s.type !== "catch");
  if (own && own.type === "module") return true;
  const at = cf.functionLocation;
  return !!at && at.lineNumber === 0 && at.columnNumber === 0;
}

/** `Point.dist`, `new Node`, `(top level)`, `(anonymous)`. */
function frameName(cf) {
  const fn = cf.functionName;
  const cls = cf.this && cf.this.type === "object" && cf.this.className && !/^(Object|global|Window|Module)$/.test(cf.this.className) ? cf.this.className : "";
  if (!fn) return isTopLevel(cf) ? "(top level)" : "(anonymous)";
  if (cls && fn === cls) return `new ${fn}`;
  return cls ? `${cls}.${fn}` : fn;
}

async function frameVariables(cf) {
  const top = isTopLevel(cf);
  const out = [];
  const seen = new Set();
  const add = (v) => {
    if (seen.has(v.name)) return;
    seen.add(v.name);
    out.push(v);
  };
  if (!top && cf.this && cf.this.type === "object" && cf.this.objectId && !/^(global|Window|Module)$/.test(cf.this.className || "")) {
    // The frame's `this` comes without a preview: read it again with one.
    const r = await cdp("Debugger.evaluateOnCallFrame", { callFrameId: cf.callFrameId, expression: "this", generatePreview: true, throwOnSideEffect: true, silent: true }).catch(() => null);
    add(describe("this", r && r.result && !r.exceptionDetails ? r.result : cf.this));
  }
  const groups = [];
  // Innermost blocks first, then the function's own scope; outer ones as groups.
  let own = true;
  for (const s of cf.scopeChain) {
    if (s.type === "global") break;
    if (own && (s.type === "block" || s.type === "catch" || s.type === "local" || s.type === "module" || s.type === "script")) {
      const vars = (await properties(s.object.objectId)).result;
      for (const p of vars) {
        if (!p.value || (top && HIDDEN.has(p.name))) continue;
        add(describe(p.name, p.value));
      }
      if (s.type === "local" || s.type === "module") own = false;
    } else if (s.type === "closure" || s.type === "module" || s.type === "script") {
      groups.push(s);
    }
  }
  for (const s of groups) {
    const vars = (await properties(s.object.objectId)).result.filter((p) => p.value && !HIDDEN.has(p.name));
    if (vars.length === 0) continue;
    const label = s.type === "closure" && s.name ? `outer variables of ${s.name}` : "outer variables";
    out.push({ name: s.type === "closure" ? "closure" : "top level", value: `${label} (${vars.length})`, type: "", ref: register({ kind: "scope", objectId: s.object.objectId }) });
  }
  return out;
}

async function variables(ref) {
  const target = refs.get(ref);
  if (!target) throw new Error("variable reference expired; the program has resumed");
  if (target.kind === "frame") return frameVariables(target.frame);
  if (target.kind === "scope") {
    const vars = (await properties(target.objectId)).result.filter((p) => p.value && !HIDDEN.has(p.name));
    return vars.slice(0, MAX_CHILDREN).map((p) => describe(p.name, p.value));
  }
  return children(target.object);
}

// ---------------------------------------------------------------- execution

let child = null;
let paused = false; // stopped and shown to the user
let stack = []; // project call frames at the current stop, innermost first
let stopReason = null;
/** What the user asked for when the program last resumed: null | "in" | "over" | "out" | "pause". */
let mode = null;
let ready = false;

function resumeWith(cmd) {
  paused = false;
  stack = [];
  refs = new Map();
  nextRef = 1;
  event("continued");
  return cdp(cmd);
}

on("Debugger.paused", async (p) => {
  const frames = p.callFrames;
  const top = frames[0];
  const exception = p.reason === "exception" || p.reason === "promiseRejection";
  if (!top || !isProjectFrame(top)) {
    // In Node's own code (console.log, timers, loading) or an initialiser the compiler made.
    const called = frames.some(isProjectFrame);
    if (exception && called) return stop(p, frames.filter(isProjectFrame), "exception");
    if (top && inProject(urlOf(top))) return void cdp("Debugger.stepInto");
    if (mode === null && !exception) return void cdp("Debugger.resume");
    if (called) return void cdp("Debugger.stepOut");
    // Paused in Node's own code (loading, waiting for input or timers): run on, and ask again shortly,
    // until the pause lands in the program. Stepping with no program code left: run on.
    if (mode === "pause" && pauseFd !== null) {
      setTimeout(() => mode === "pause" && !paused && fs.writeSync(pauseFd, "p"), 100);
    }
    return void cdp("Debugger.resume");
  }
  const reason = exception ? "exception" : p.hitBreakpoints && p.hitBreakpoints.length ? "breakpoint" : mode === "pause" ? "pause" : mode ? "step" : "breakpoint";
  return stop(p, frames.filter(isProjectFrame), reason);
});

function stop(p, frames, reason) {
  paused = true;
  mode = null;
  stack = frames;
  stopReason = reason;
  refs = new Map();
  nextRef = 1;
  const body = {
    reason,
    thread: THREAD,
    frames: frames.map((cf, i) => ({ id: i, name: frameName(cf), file: relative(urlOf(cf)), line: lineOf(cf.location), localsRef: register({ kind: "frame", frame: cf }) })),
  };
  if (reason === "exception") {
    const d = p.data && (p.data.description || p.data.value);
    body.description = String(d || "Uncaught exception").split("\n")[0].slice(0, 300);
  }
  event("stopped", body);
}

async function evaluate(expression, index) {
  const cf = stack[index];
  if (!cf) return { error: "That frame is no longer available." };
  const r = await cdp("Debugger.evaluateOnCallFrame", {
    callFrameId: cf.callFrameId,
    expression,
    generatePreview: true,
    silent: true,
    throwOnSideEffect: true,
    timeout: 1000,
  });
  if (r.exceptionDetails) {
    const text = String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "error").split("\n")[0];
    if (/side-effect/i.test(text)) return { error: "This expression would run program code (a call, an assignment or a getter), so watches do not evaluate it." };
    if (/timed? ?out|Execution was terminated/i.test(text)) return { error: "The expression took too long to evaluate." };
    return { error: text };
  }
  return { result: format(r.result) };
}

async function handle(req) {
  const { seq, cmd } = req;
  switch (cmd) {
    case "setBreakpoints": {
      const file = String(req.file || "");
      const lines = [...new Set((req.lines || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
      if (lines.length) breakpoints.set(file, new Set(lines));
      else breakpoints.delete(file);
      return respond(seq, true, undefined, { file, breakpoints: await placeBreakpoints(file) });
    }
    case "pause":
      if (!paused) {
        mode = "pause";
        // Through the program's own pauser thread: the inspector socket is not served while the program computes.
        if (pauseFd !== null) fs.writeSync(pauseFd, "p");
        else await cdp("Debugger.pause");
        // V8 cannot interrupt a loop in a function that has a breakpoint set: say so rather than wait forever.
        for (let waited = 0; !paused && waited < 1500 && child && child.exitCode === null; waited += 50) await new Promise((r) => setTimeout(r, 50));
        if (!paused && child && child.exitCode === null && [...breakpoints.values()].some((l) => l.size > 0)) {
          return respond(seq, false, "The program is busy in a loop inside a function that has a breakpoint, which JavaScript cannot interrupt. Stop the program, or remove that function's breakpoints before running it.");
        }
      }
      return respond(seq);
    case "continue":
    case "stepOver":
    case "stepIn":
    case "stepOut": {
      if (!paused) return cmd === "continue" ? respond(seq) : respond(seq, false, "The program is not paused.");
      // After an uncaught exception there is nothing left to step through: the program ends.
      const step = stopReason === "exception" ? "continue" : cmd;
      mode = { continue: null, stepOver: "over", stepIn: "in", stepOut: "out" }[step];
      respond(seq);
      return resumeWith({ continue: "Debugger.resume", stepOver: "Debugger.stepOver", stepIn: "Debugger.stepInto", stepOut: "Debugger.stepOut" }[step]);
    }
    case "variables":
      if (!paused) return respond(seq, false, "The program is running.");
      return respond(seq, true, undefined, { ref: req.ref, variables: await variables(req.ref) });
    case "evaluate": {
      const expression = String(req.expression || "");
      if (!paused) return respond(seq, true, undefined, { expression, error: "The program is running." });
      return respond(seq, true, undefined, { expression, ...(await evaluate(expression, req.frame || 0)) });
    }
    case "terminate":
      respond(seq);
      if (child) child.kill("SIGKILL");
      return exit(0);
    default:
      return respond(seq, false, `unknown command: ${cmd}`);
  }
}

// ------------------------------------------------------------------ launch

// Pausing a program that is busy computing. Node serves the inspector socket only
// when the program is idle, but a session a worker thread opens inside the program
// interrupts it at once. The preload starts that worker (unref'd, so it never keeps
// the program alive) and waits until its session is ready; the worker pauses the
// program for every byte the adapter writes to the pause pipe.
const PAUSE_PIPE = "/tmp/cw-pause";
const PRELOAD = "/tmp/cw_pause.cjs";
const PAUSE_WORKER = "/tmp/cw_pause_worker.cjs";
let pauseFd = null;

const PRELOAD_SOURCE = `"use strict";
(() => {
  const { Worker, isMainThread } = require("node:worker_threads");
  // Worker threads inherit --require: only the program's main thread gets a pauser.
  if (!isMainThread) return;
  const pipe = process.env.CW_PAUSE_PIPE;
  delete process.env.CW_PAUSE_PIPE;
  if (!pipe) return;
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(${JSON.stringify(PAUSE_WORKER)}, { workerData: { pipe, ready }, execArgv: [] });
  w.unref();
  w.on("error", () => {});
  // At exit Node waits for every debugger session to leave: the pauser leaves at once.
  process.on("exit", () => w.postMessage("exit"));
  Atomics.wait(ready, 0, 0, 5000);
})();
`;

const WORKER_SOURCE = `"use strict";
const fs = require("node:fs");
const inspector = require("node:inspector");
const { workerData, parentPort } = require("node:worker_threads");
// An inspector call does not keep a thread alive; this does (the program can still exit: the thread is unref'd).
parentPort.on("message", () => {
  try {
    session.disconnect();
  } catch {}
  parentPort.close();
});
const session = new inspector.Session();
session.connectToMainThread();
session.post("Debugger.enable", () => {
  Atomics.store(workerData.ready, 0, 1);
  Atomics.notify(workerData.ready, 0);
  // Read as a socket: never blocks this thread (its event loop must run for requests to go out)
  // and holds no thread-pool read that would keep the program from exiting.
  const fd = fs.openSync(workerData.pipe, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  new (require("node:net").Socket)({ fd, readable: true, writable: false })
    .on("data", () => session.post("Debugger.pause"))
    .on("error", () => {});
});
`;

/** Writes the pauser and opens its pipe; null when that is not possible here. */
function pauser() {
  try {
    fs.writeFileSync(PRELOAD, PRELOAD_SOURCE);
    fs.writeFileSync(PAUSE_WORKER, WORKER_SOURCE);
    if (!fs.existsSync(PAUSE_PIPE)) require("node:child_process").execFileSync("mkfifo", [PAUSE_PIPE]);
    pauseFd = fs.openSync(PAUSE_PIPE, "r+");
    return PRELOAD;
  } catch {
    pauseFd = null;
    return null;
  }
}

/** Node's own inspector notices, which a normal run never prints. */
const NOTICE = /^(Debugger listening on .*|For help, see: .*|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.|Debugger ending on .*)\r?\n/gm;

function launch(req) {
  root = path.resolve(req.root || process.cwd());
  transformTypes = (req.nodeArgs || []).includes("--experimental-transform-types");
  files = new Set((req.files || []).map(String));
  rootUrl = new RegExp(`^(file://)?${escape(root)}/`);
  for (const [file, lines] of Object.entries(req.breakpoints || {})) if (lines && lines.length) breakpoints.set(file, new Set(lines.map(Number)));
  let stdin = "ignore";
  try {
    if (req.stdinPath && fs.existsSync(req.stdinPath)) stdin = fs.openSync(req.stdinPath, "r");
  } catch {}
  const preload = pauser();
  const args = [...(req.nodeArgs || []), ...(preload ? ["--require", preload] : []), "--inspect-wait=127.0.0.1:0", path.join(root, req.entry)];
  child = spawn(process.execPath, args, { cwd: root, stdio: [stdin, "pipe", "pipe"], env: preload ? { ...process.env, CW_PAUSE_PIPE: PAUSE_PIPE } : process.env });
  if (typeof stdin === "number") fs.closeSync(stdin);

  let stdoutOpen = true;
  let stderrOpen = true;
  let exitCode = null;
  const finish = () => {
    if (stdoutOpen || stderrOpen || exitCode === null) return;
    event("exited", { exitCode });
    exit(0);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => event("output", { stream: "stdout", text }));
  child.stdout.on("end", () => ((stdoutOpen = false), finish()));

  return new Promise((resolve, reject) => {
    let head = "";
    let connected = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => {
      if (!connected) {
        head += text;
        const m = /Debugger listening on (ws:\/\/\S+)/.exec(head);
        if (!m) return;
        connected = true;
        const rest = head.replace(NOTICE, "");
        if (rest) event("output", { stream: "stderr", text: rest });
        resolve(m[1]);
        return;
      }
      const shown = text.replace(NOTICE, "");
      if (shown) event("output", { stream: "stderr", text: shown });
    });
    child.stderr.on("end", () => ((stderrOpen = false), finish()));
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 + (require("node:os").constants.signals[signal] || 9) : 1);
      if (!connected) reject(new Error(head.trim() || "the program did not start"));
      try {
        ws && ws.close();
      } catch {}
      finish();
    });
    child.on("error", reject);
  });
}

async function start(req) {
  const url = await launch(req);
  await connect(url);
  // When the program is done, Node waits for the debugger to let go: let go at once.
  on("Runtime.executionContextDestroyed", () => {
    try {
      ws.close();
    } catch {}
  });
  await cdp("Runtime.enable");
  await cdp("Debugger.enable");
  await cdp("Debugger.setPauseOnExceptions", { state: "uncaught" });
  for (const file of breakpoints.keys()) event("breakpoints", { file, breakpoints: await placeBreakpoints(file) });
  await cdp("Runtime.runIfWaitingForDebugger");
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let req;
    try {
      req = JSON.parse(line);
      if (typeof req !== "object" || req === null) throw new Error("expected an object");
    } catch (e) {
      return event("error", { message: `invalid request: ${e.message}` });
    }
    // Commands are handled one at a time, in order.
    queue = queue.then(async () => {
      if (!ready) {
        if (req.cmd !== "launch") return respond(req.seq, false, "program not launched");
        try {
          await start(req);
          ready = true;
          respond(req.seq);
          event("continued");
        } catch (e) {
          respond(req.seq, false, e && e.message ? e.message : String(e));
          exit(1);
        }
        return;
      }
      try {
        await handle(req);
      } catch (e) {
        respond(req.seq, false, e && e.message ? e.message : String(e));
      }
    });
  });
  // The worker closed the channel: the session is over.
  rl.on("close", () => {
    if (child) child.kill("SIGKILL");
    process.exit(0);
  });
}

main();
