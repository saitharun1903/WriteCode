import { readFile } from "node:fs/promises";
import type Docker from "dockerode";
import { SANDBOX_WORKDIR, expandCommand, requireLanguage, type ExecutionRequest } from "@cw/shared";
import type { SandboxFile } from "../sandbox/files.js";
import { ADAPTER_DIR, ADAPTER_MAIN, javaAdapterClasses } from "./java-adapter.js";

/** How to start a language's debug adapter inside the sandbox. */
export interface DebugAdapter {
  /** Adapter files written into the sandbox next to the project. */
  files: SandboxFile[];
  /** Command that starts the adapter; it speaks JSON lines on stdin/stdout. */
  argv: string[];
  /** Language-specific fields of the initial `launch` request. */
  launch: Record<string, unknown>;
  /** Setup commands to run after the files are written. */
  setup: string[][];
  /**
   * Whether the kernel wait-channel monitor can tell when the program waits
   * for input. False when the adapter reports input waits itself.
   */
  monitorInput: boolean;
}

const STDIN_PATH = "/tmp/cw-stdin";
/** JDI launches `<home>/bin/java`; this wrapper gives the program its stdin directly. */
const JAVA_WRAPPER_HOME = "/tmp/cwdbg/jvm";
const PYTHON_ADAPTER_URL = new URL("../../debug-adapters/python/cw_debug_adapter.py", import.meta.url);
const PYTHON_ADAPTER_PATH = "/tmp/cwdbg/cw_debug_adapter.py";
const NODE_ADAPTER_URL = new URL("../../debug-adapters/javascript/cw_debug_adapter.cjs", import.meta.url);
const NODE_ADAPTER_PATH = "/tmp/cwdbg/cw_debug_adapter.cjs";

let pythonSource: Promise<string> | null = null;
let nodeSource: Promise<string> | null = null;

/** Reads an adapter's source once; a failed read is retried next time. */
function source(url: URL, cached: Promise<string> | null, set: (p: Promise<string> | null) => void): Promise<string> {
  if (cached) return cached;
  const p = readFile(url, "utf8").catch((e: unknown) => {
    set(null);
    throw e;
  });
  set(p);
  return p;
}

/** `stdinPath` is the program's stdin: the input file, or the interactive FIFO. */
export async function debugAdapterFor(docker: Docker, request: ExecutionRequest, stdinPath = STDIN_PATH): Promise<DebugAdapter> {
  const common = { stdinPath, files: request.files.map((f) => f.path), breakpoints: request.breakpoints ?? {} };
  switch (request.language) {
    case "java": {
      const lang = requireLanguage("java");
      const mainClass = expandCommand(["{entryClass}"], { entry: request.entry, files: request.files })[0]!;
      // Program JVM flags mirror normal runs, with a heap cap so both JVMs fit.
      const vmOptions = lang.runtime.command.filter((a) => a.startsWith("-X")).concat("-Xmx192m").join(" ");
      const wrapper = `${JAVA_WRAPPER_HOME}/bin/java`;
      return {
        files: [
          ...(await javaAdapterClasses(docker)),
          { path: wrapper, content: ["#!/bin/sh", `exec "\${JAVA_HOME:-/opt/java/openjdk}/bin/java" "$@" < ${stdinPath}`, ""].join("\n") },
        ],
        argv: ["java", "-Xmx64m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xshare:auto", "-cp", ADAPTER_DIR, ADAPTER_MAIN],
        launch: { ...common, mainClass, classpath: "out", vmOptions, javaHome: JAVA_WRAPPER_HOME },
        setup: [["chmod", "755", wrapper]],
        monitorInput: true,
      };
    }
    case "python": {
      pythonSource ??= readFile(PYTHON_ADAPTER_URL, "utf8").catch((e: unknown) => {
        pythonSource = null;
        throw e;
      });
      return {
        files: [{ path: PYTHON_ADAPTER_PATH, content: await pythonSource }],
        argv: ["python3", PYTHON_ADAPTER_PATH],
        launch: { ...common, entry: request.entry, root: SANDBOX_WORKDIR },
        setup: [],
        // The adapter's own command reader also blocks on a pipe, so it reports input waits itself.
        monitorInput: false,
      };
    }
    case "javascript":
    case "typescript": {
      const lang = requireLanguage(request.language);
      return {
        files: [{ path: NODE_ADAPTER_PATH, content: await source(NODE_ADAPTER_URL, nodeSource, (p) => (nodeSource = p)) }],
        argv: ["node", NODE_ADAPTER_PATH],
        launch: {
          ...common,
          entry: request.entry,
          root: SANDBOX_WORKDIR,
          // The program runs with the flags of a normal run (TypeScript's transform).
          nodeArgs: lang.runtime.command.slice(1).filter((a) => a.startsWith("--")),
        },
        setup: [],
        // The program is its own process reading its stdin, as in a normal run.
        monitorInput: true,
      };
    }
    default:
      throw new Error(`no debug adapter for ${request.language}`);
  }
}
