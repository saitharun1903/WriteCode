"use strict";
/**
 * The recorder half of the JavaScript tracer: runs on a worker thread,
 * connected to the main thread's inspector. At every pause in a project file
 * it snapshots the stack through the main thread's `cw.trace` api, then steps
 * into the next statement. See cw_trace.cjs.
 */

const fs = require("node:fs");
const inspector = require("node:inspector");
const { parentPort, workerData } = require("node:worker_threads");

const { config, done, root } = workerData;
const L = config.limits;
const session = new inspector.Session();
session.connectToMainThread();

const post = (method, params = {}) =>
  new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rootUrl = new RegExp(`^(file://)?${escape(root)}/`);
const inProject = (url) => rootUrl.test(url);
/** Script urls by id: pause events give each frame's script id (their `url` field is empty). */
const scripts = new Map();
/** Generated line -> [[column, source line]] for project scripts Node transformed (TypeScript enums...). */
const sourceMaps = new Map();
session.on("Debugger.scriptParsed", ({ params }) => {
  scripts.set(params.scriptId, params.url);
  const m = /^data:application\/json;(?:charset=[^;,]+;)?base64,(.*)$/.exec(params.sourceMapURL || "");
  if (m && inProject(params.url)) {
    try {
      sourceMaps.set(params.scriptId, decodeMappings(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")).mappings));
    } catch {}
  }
});

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
const urlOf = (cf) => cf.url || scripts.get(cf.location.scriptId) || "";
const relative = (url) => decodeURIComponent(url.replace(/^file:\/\//, "")).slice(root.length + 1);

const steps = [];
let truncated = null;
let recording = true;
let apiId = null;
const started = Date.now();
/** Leave time for the program to finish and the trace to be written. */
const BUDGET_MS = 14_000;

async function call(fn, args = []) {
  const r = await post("Runtime.callFunctionOn", { objectId: apiId, functionDeclaration: fn, arguments: args, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

const argOf = (remote) =>
  remote.objectId ? { objectId: remote.objectId } : remote.unserializableValue !== undefined ? { unserializableValue: remote.unserializableValue } : remote.type === "undefined" ? {} : { value: remote.value };

/** `Point.dist`, `new Node`, `(top level)`, `(anonymous)`. */
function frameName(cf) {
  const fn = cf.functionName;
  const cls = cf.this && cf.this.type === "object" && cf.this.className && !/^(Object|global|Window|Module)$/.test(cf.this.className) ? cf.this.className : "";
  if (!fn) return isTopLevel(cf) ? "(top level)" : "(anonymous)";
  if (cls && fn === cls) return `new ${fn}`;
  return cls ? `${cls}.${fn}` : fn;
}

/** The module wrapper of a CommonJS file, or an ES module's body. */
function isTopLevel(cf) {
  if (cf.functionName) return false;
  // An ES module's body: its own scope is the module scope (a callback inside it has a local scope first).
  const own = cf.scopeChain.find((s) => s.type !== "block" && s.type !== "catch");
  if (own && own.type === "module") return true;
  // CommonJS: Node wraps the file in a function that starts at its very first character.
  const at = cf.functionLocation;
  return !!at && at.lineNumber === 0 && at.columnNumber === 0;
}

async function snapshot(params) {
  // Frames the compiler made up (TypeScript field initialisers) are not the program's.
  const frames = params.callFrames.filter((cf) => inProject(urlOf(cf)) && !cf.functionName.startsWith("<")).reverse();
  if (frames.length === 0) return null;
  await call("function () { this.begin(); }");
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const cf = frames[i];
    const top = isTopLevel(cf);
    // Innermost blocks first, up to the function's own scope (or the module's).
    const scopes = [];
    for (const s of cf.scopeChain) {
      if (s.type === "block" || s.type === "catch" || s.type === "local" || s.type === "module") scopes.push(s);
      if (s.type === "local" || s.type === "module") break;
    }
    const seen = new Set();
    const locals = [];
    for (const s of scopes.reverse()) {
      const vars = JSON.parse(await call("function (scope, top) { return this.scope(scope, top); }", [{ objectId: s.object.objectId }, { value: top }]));
      for (const [n, v] of vars) {
        const at = locals.findIndex(([m]) => m === n);
        if (at >= 0) locals[at] = [n, v];
        else locals.push([n, v]);
        seen.add(n);
      }
    }
    // `this` in methods and constructors, like Python's self and Java's this.
    if (!top && cf.this && cf.this.type === "object" && cf.this.objectId && !/^(global|Window|Module)$/.test(cf.this.className || "")) {
      locals.unshift(["this", JSON.parse(await call("function (v) { return this.one(v); }", [{ objectId: cf.this.objectId }]))]);
    }
    const frame = { name: frameName(cf), file: relative(urlOf(cf)), line: lineOf(cf.location), locals };
    if (i === frames.length - 1 && cf.returnValue && !top) frame.returnValue = JSON.parse(await call("function (v) { return this.one(v); }", [argOf(cf.returnValue)]));
    out.push(frame);
  }
  const { heap, stdoutLength } = JSON.parse(await call("function () { return this.end(); }"));
  const last = frames[frames.length - 1];
  let event = last.returnValue && !isTopLevel(last) ? "return" : "line";
  const step = { event, frames: out, heap, stdoutLength };
  if (params.reason === "exception" || params.reason === "promiseRejection") {
    event = "exception";
    step.event = event;
    const d = params.data && (params.data.description || params.data.value);
    step.exception = String(d || "Error").split("\n")[0].slice(0, 300);
  }
  return step;
}

function stop(reason) {
  recording = false;
  truncated = reason;
  post("Debugger.setBreakpointsActive", { active: false }).catch(() => {});
  post("Debugger.resume").catch(() => {});
  post("Debugger.disable").catch(() => {});
}

let lastKey = "";
let pauses = 0;
session.on("Debugger.paused", async ({ params }) => {
  if (process.env.CW_TRACE_DEBUG) fs.writeSync(2, `pause ${++pauses} ${params.reason} ${params.callFrames[0] ? urlOf(params.callFrames[0]) : ""}:${params.callFrames[0]?.location.lineNumber}
`);
  if (!recording) return void post("Debugger.resume").catch(() => {});
  try {
    const inside = params.callFrames.length > 0 && inProject(urlOf(params.callFrames[0])) && !params.callFrames[0].functionName.startsWith("<");
    if (!inside) {
      // In Node's own code: called from the program (console.log...), step back out to it;
      // otherwise (loading, timers, the end of the run) run on until a project line is reached.
      const called = params.callFrames.some((cf) => inProject(urlOf(cf)));
      return void (await post(called ? "Debugger.stepOut" : "Debugger.resume"));
    }
    if (inside) {
      const step = await snapshot(params);
      if (step) {
        // Several pauses on one line with nothing changed (parts of a `for` header) are one step.
        const key = JSON.stringify(step);
        if (key !== lastKey) steps.push(step);
        lastKey = key;
      }
      if (steps.length >= L.maxSteps) return stop(`Recording stopped after ${L.maxSteps} steps; the program continued without recording.`);
      if (Date.now() - started > BUDGET_MS) return stop("Recording stopped because the program ran for a long time; it continued without recording.");
    }
    await post("Debugger.stepInto");
  } catch (e) {
    stop(`Recording stopped: ${e && e.message ? e.message : e}`);
  }
});

parentPort.on("message", (m) => {
  if (m.type !== "finish") return;
  try {
    const trace = { language: config.language, steps, stdout: m.stdout };
    if (truncated) trace.truncated = truncated;
    let json = JSON.stringify(trace);
    // Keep under the size limit by dropping the latest steps.
    while (json.length > L.maxTraceBytes && trace.steps.length > 1) {
      trace.steps.length = Math.floor(trace.steps.length * 0.8);
      trace.truncated = "The recording was too large; the last steps were dropped.";
      json = JSON.stringify(trace);
    }
    fs.writeFileSync(config.out, json);
  } finally {
    // Detached before the program exits, so Node does not wait "for the debugger to disconnect".
    try {
      session.disconnect();
    } catch {}
    Atomics.store(done, 0, 1);
    Atomics.notify(done, 0);
  }
});

(async () => {
  if (process.env.CW_TRACE_DEBUG) fs.writeSync(2, `[worker ${Date.now() % 100000}] start
`);
  await post("Runtime.enable");
  if (process.env.CW_TRACE_DEBUG) fs.writeSync(2, `[worker ${Date.now() % 100000}] runtime enabled
`);
  await post("Debugger.enable");
  // Step only through the project's files: Node internals and the tracer are skipped over.
  // A breakpoint on every line of every project file: the program stops wherever its code runs
  // (its first line, callbacks from timers or Node), and stepping goes on from there.
  const lines = [];
  for (const file of config.files) {
    let text = "";
    try {
      text = fs.readFileSync(require("node:path").join(root, file), "utf8");
    } catch {
      continue;
    }
    const url = `file://${root}/${file.split("/").map(encodeURIComponent).join("/")}`;
    // Transformed TypeScript can run longer than the source: cover the generated lines too.
    const count = text.split("\n").length;
    const extra = /\.m?ts$/.test(file) ? count * 2 + 40 : count;
    for (let i = 0; i < extra; i++) lines.push({ url, lineNumber: i });
  }
  await Promise.all(lines.slice(0, 5000).map((l) => post("Debugger.setBreakpointByUrl", l).catch(() => null)));
  // Every exception raised in the program is a step, caught or not (as in the Python tracer); ones raised
  // inside Node itself are passed over like any other pause there.
  await post("Debugger.setPauseOnExceptions", { state: "all" });
  const r = await post("Runtime.evaluate", { expression: 'globalThis[Symbol.for("cw.trace")]', objectGroup: "cw" });
  apiId = r.result.objectId;
  // A breakpoint at the top of every project file: the program pauses on its first statement,
  // and stepping carries on from there (into other project files too).
  parentPort.postMessage({ type: "ready" });
})().catch((e) => {
  truncated = `The recorder could not start: ${e && e.message ? e.message : e}`;
  recording = false;
  parentPort.postMessage({ type: "ready" });
});
