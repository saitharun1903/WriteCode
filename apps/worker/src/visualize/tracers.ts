import { readFile } from "node:fs/promises";
import type Docker from "dockerode";
import { SANDBOX_WORKDIR, TRACE_LIMITS, expandCommand, requireLanguage, type ExecutionLimits, type ExecutionRequest } from "@cw/shared";
import type { SandboxFile } from "../sandbox/files.js";
import { ADAPTER_DIR, javaAdapterClasses } from "../debug/java-adapter.js";

/** How to run a program under a language's tracer inside the sandbox. */
export interface Tracer {
  /** Tracer files written into the sandbox next to the project. */
  files: SandboxFile[];
  /** Replaces the language's run command. */
  argv: string[];
  /** Setup commands to run after the files are written. */
  setup: string[][];
  /** Where the tracer writes the finished trace. */
  outPath: string;
  /** Adjusted sandbox limits (tracing is slower; Java runs two JVMs). */
  limits: (base: ExecutionLimits) => ExecutionLimits;
  /**
   * True when the tracer itself is the program and reads stdin (Python). False
   * when it launches the program separately, which gets stdin on its own (Java).
   */
  ownsStdin: boolean;
}

const TRACE_DIR = "/tmp/cwviz";
const OUT_PATH = "/tmp/cw-trace.json";
const PYTHON_TRACER_URL = new URL("../../tracers/python/cw_trace.py", import.meta.url);
const JAVA_WRAPPER_HOME = `${TRACE_DIR}/jvm`;

const JS_TRACER_URL = new URL("../../tracers/javascript/cw_trace.cjs", import.meta.url);
const JS_TRACER_WORKER_URL = new URL("../../tracers/javascript/cw_trace_worker.cjs", import.meta.url);

const GDB_TRACER_URL = new URL("../../tracers/gdb/cw_trace_gdb.py", import.meta.url);

let pythonSource: Promise<string> | null = null;
let gdbSource: Promise<string> | null = null;
let jsSources: Promise<[string, string]> | null = null;

/** Tracing single-steps every line, so allow more time than a normal run. */
const slower = (base: ExecutionLimits): ExecutionLimits => ({ ...base, timeoutMs: Math.max(base.timeoutMs, 20_000) });

/** `stdinPath` is the program's stdin: the prepared input file, or the interactive FIFO. */
export async function tracerFor(docker: Docker, request: ExecutionRequest, stdinPath: string): Promise<Tracer> {
  const files = request.files.map((f) => f.path);
  switch (request.language) {
    case "python": {
      pythonSource ??= readFile(PYTHON_TRACER_URL, "utf8").catch((e: unknown) => {
        pythonSource = null;
        throw e;
      });
      const config = { entry: request.entry, root: SANDBOX_WORKDIR, files, out: OUT_PATH, limits: TRACE_LIMITS };
      return {
        files: [
          { path: `${TRACE_DIR}/cw_trace.py`, content: await pythonSource },
          { path: `${TRACE_DIR}/config.json`, content: JSON.stringify(config) },
        ],
        argv: ["python3", "-u", `${TRACE_DIR}/cw_trace.py`, `${TRACE_DIR}/config.json`],
        setup: [],
        outPath: OUT_PATH,
        limits: slower,
        ownsStdin: true,
      };
    }
    case "java": {
      const lang = requireLanguage("java");
      const mainClass = expandCommand(["{entryClass}"], { entry: request.entry, files: request.files })[0]!;
      const vmOptions = lang.runtime.command.filter((a) => a.startsWith("-X")).concat("-Xmx192m").join(" ");
      const config = { mainClass, classpath: "out", vmOptions, javaHome: JAVA_WRAPPER_HOME, files, out: OUT_PATH, limits: TRACE_LIMITS };
      const wrapper = `${JAVA_WRAPPER_HOME}/bin/java`;
      return {
        files: [
          ...(await javaAdapterClasses(docker)),
          { path: `${TRACE_DIR}/config.json`, content: JSON.stringify(config) },
          // JDI launches `<home>/bin/java`; the wrapper gives the program its stdin directly.
          { path: wrapper, content: ["#!/bin/sh", `exec "\${JAVA_HOME:-/opt/java/openjdk}/bin/java" "$@" < ${stdinPath}`, ""].join("\n") },
        ],
        argv: ["java", "-Xmx96m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xshare:auto", "-cp", ADAPTER_DIR, "CwTracer", `${TRACE_DIR}/config.json`],
        setup: [["chmod", "755", wrapper]],
        outPath: OUT_PATH,
        // Two JVMs share the sandbox, as in a debug session.
        limits: (base) => ({ ...slower(base), memoryMb: Math.max(base.memoryMb, 512), pids: Math.max(base.pids, 256) }),
        ownsStdin: false,
      };
    }
    case "javascript":
    case "typescript": {
      jsSources ??= Promise.all([readFile(JS_TRACER_URL, "utf8"), readFile(JS_TRACER_WORKER_URL, "utf8")]).catch((e: unknown) => {
        jsSources = null;
        throw e;
      });
      const [main, worker] = await jsSources;
      const config = { entry: request.entry, root: SANDBOX_WORKDIR, files, out: OUT_PATH, language: request.language, limits: TRACE_LIMITS };
      // The language's own Node flags (TypeScript's type transform), then the tracer instead of the entry file.
      const flags = requireLanguage(request.language).runtime.command.slice(1).filter((a) => a.startsWith("--"));
      return {
        files: [
          { path: `${TRACE_DIR}/cw_trace.cjs`, content: main },
          { path: `${TRACE_DIR}/cw_trace_worker.cjs`, content: worker },
          { path: `${TRACE_DIR}/config.json`, content: JSON.stringify(config) },
        ],
        argv: ["node", ...flags, `${TRACE_DIR}/cw_trace.cjs`, `${TRACE_DIR}/config.json`],
        setup: [],
        outPath: OUT_PATH,
        limits: slower,
        ownsStdin: true,
      };
    }
    case "c":
    case "cpp": {
      gdbSource ??= readFile(GDB_TRACER_URL, "utf8").catch((e: unknown) => {
        gdbSource = null;
        throw e;
      });
      const config = { root: SANDBOX_WORKDIR, files, out: OUT_PATH, language: request.language, program: "out/main", stdin: stdinPath, limits: TRACE_LIMITS };
      return {
        files: [
          { path: `${TRACE_DIR}/cw_trace_gdb.py`, content: await gdbSource },
          { path: `${TRACE_DIR}/config.json`, content: JSON.stringify(config) },
        ],
        // gdb runs the compiled program as its child, one line at a time (config at /tmp/cwviz/config.json).
        argv: ["gdb", "-q", "-nx", "-batch", "-x", `${TRACE_DIR}/cw_trace_gdb.py`],
        setup: [],
        outPath: OUT_PATH,
        limits: slower,
        // The program reads its stdin itself (redirected by gdb), as in a normal run.
        ownsStdin: false,
      };
    }
    default:
      throw new Error(`no tracer for ${request.language}`);
  }
}
