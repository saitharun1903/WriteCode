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
const GDB_ADAPTER_URL = new URL("../../debug-adapters/gdb/cw_gdb_adapter.py", import.meta.url);
const GDB_ADAPTER_PATH = "/tmp/cwdbg/cw_gdb_adapter.py";
/** What the gdb adapter and tracer need to know about Rust, written next to them for a Rust program. */
export const GDB_RUST_URL = new URL("../../debug-adapters/gdb/cw_gdb_rust.py", import.meta.url);
let gdbRustSource: Promise<string> | null = null;
export const gdbRust = () => source(GDB_RUST_URL, gdbRustSource, (p) => (gdbRustSource = p));
const DLV_ADAPTER_URL = new URL("../../debug-adapters/dlv/cw_dlv_adapter.py", import.meta.url);
/** Starting Delve and reading Go values: shared by the Go debugger and tracer. */
const DLV_MODULE_URL = new URL("../../debug-adapters/dlv/cw_dlv.py", import.meta.url);
let dlvAdapterSource: Promise<string> | null = null;
let dlvModuleSource: Promise<string> | null = null;
export const dlvModule = () => source(DLV_MODULE_URL, dlvModuleSource, (p) => (dlvModuleSource = p));
const DBGP_ADAPTER_URL = new URL("../../debug-adapters/dbgp/cw_dbgp_adapter.py", import.meta.url);
/** Starting PHP under Xdebug and reading PHP values: shared by the PHP debugger and tracer. */
const DBGP_MODULE_URL = new URL("../../debug-adapters/dbgp/cw_dbgp.py", import.meta.url);
let dbgpAdapterSource: Promise<string> | null = null;
let dbgpModuleSource: Promise<string> | null = null;
export const dbgpModule = () => source(DBGP_MODULE_URL, dbgpModuleSource, (p) => (dbgpModuleSource = p));
const NETCOREDBG_ADAPTER_URL = new URL("../../debug-adapters/netcoredbg/cw_netcoredbg_adapter.py", import.meta.url);
/** Starting netcoredbg and reading C# values: shared by the C# debugger and tracer. */
const NETCOREDBG_MODULE_URL = new URL("../../debug-adapters/netcoredbg/cw_netcoredbg.py", import.meta.url);
let netcoredbgAdapterSource: Promise<string> | null = null;
let netcoredbgModuleSource: Promise<string> | null = null;
export const netcoredbgModule = () => source(NETCOREDBG_MODULE_URL, netcoredbgModuleSource, (p) => (netcoredbgModuleSource = p));
const NODE_ADAPTER_URL = new URL("../../debug-adapters/javascript/cw_debug_adapter.cjs", import.meta.url);
const NODE_ADAPTER_PATH = "/tmp/cwdbg/cw_debug_adapter.cjs";
const RUBY_ADAPTER_URL = new URL("../../debug-adapters/ruby/cw_debug_adapter.rb", import.meta.url);
const RUBY_ADAPTER_PATH = "/tmp/cwdbg/cw_debug_adapter.rb";

let pythonSource: Promise<string> | null = null;
let nodeSource: Promise<string> | null = null;
let gdbSource: Promise<string> | null = null;
let rubySource: Promise<string> | null = null;

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

/** The class path a JVM language runs with (the value after `-cp` in its run command). */
export function classpathOf(command: readonly string[]): string {
  const at = command.indexOf("-cp");
  return at >= 0 && command[at + 1] ? command[at + 1]! : "out";
}

/** `stdinPath` is the program's stdin: the input file, or the interactive FIFO. */
export async function debugAdapterFor(docker: Docker, request: ExecutionRequest, stdinPath = STDIN_PATH): Promise<DebugAdapter> {
  const common = { stdinPath, files: request.files.map((f) => f.path), breakpoints: request.breakpoints ?? {} };
  // The tooling is chosen by how the language is debugged, so a language added with a known protocol needs nothing here.
  switch (requireLanguage(request.language).debugger?.protocol) {
    case "jdwp": {
      const lang = requireLanguage(request.language);
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
        launch: { ...common, mainClass, classpath: classpathOf(lang.runtime.command), vmOptions, javaHome: JAVA_WRAPPER_HOME },
        setup: [["chmod", "755", wrapper]],
        monitorInput: true,
      };
    }
    case "settrace": {
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
    case "inspector": {
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
    case "gdb":
      return {
        files: [
          { path: GDB_ADAPTER_PATH, content: await source(GDB_ADAPTER_URL, gdbSource, (p) => (gdbSource = p)) },
          ...(request.language === "rust" ? [{ path: "/tmp/cwdbg/cw_gdb_rust.py", content: await gdbRust() }] : []),
        ],
        // gdb runs the adapter; the program is gdb's child, reading its stdin as in a normal run.
        argv: ["gdb", "-q", "-nx", "-batch", "-x", GDB_ADAPTER_PATH],
        launch: { ...common, root: SANDBOX_WORKDIR, program: "out/main", language: request.language },
        setup: [],
        monitorInput: true,
      };
    case "delve":
      return {
        files: [
          { path: "/tmp/cwdbg/cw_dlv_adapter.py", content: await source(DLV_ADAPTER_URL, dlvAdapterSource, (p) => (dlvAdapterSource = p)) },
          { path: "/tmp/cwdbg/cw_dlv.py", content: await dlvModule() },
        ],
        // Delve runs the program as its child, reading its stdin as in a normal run.
        argv: ["python3", "/tmp/cwdbg/cw_dlv_adapter.py"],
        launch: { ...common, root: SANDBOX_WORKDIR, program: "out/main" },
        setup: [],
        monitorInput: true,
      };
    case "netcoredbg":
      return {
        files: [
          { path: "/tmp/cwdbg/cw_netcoredbg_adapter.py", content: await source(NETCOREDBG_ADAPTER_URL, netcoredbgAdapterSource, (p) => (netcoredbgAdapterSource = p)) },
          { path: "/tmp/cwdbg/cw_netcoredbg.py", content: await netcoredbgModule() },
        ],
        // The program runs under netcoredbg, reading its stdin as in a normal run.
        argv: ["python3", "/tmp/cwdbg/cw_netcoredbg_adapter.py"],
        launch: { ...common, root: SANDBOX_WORKDIR, program: "out/main.dll" },
        setup: [],
        monitorInput: true,
      };
    case "dbgp":
      return {
        files: [
          { path: "/tmp/cwdbg/cw_dbgp_adapter.py", content: await source(DBGP_ADAPTER_URL, dbgpAdapterSource, (p) => (dbgpAdapterSource = p)) },
          { path: "/tmp/cwdbg/cw_dbgp.py", content: await dbgpModule() },
        ],
        // PHP runs as the adapter's child, reading its stdin as in a normal run.
        argv: ["python3", "/tmp/cwdbg/cw_dbgp_adapter.py"],
        launch: { ...common, entry: request.entry, root: SANDBOX_WORKDIR },
        setup: [],
        monitorInput: true,
      };
    case "tracepoint":
      return {
        files: [{ path: RUBY_ADAPTER_PATH, content: await source(RUBY_ADAPTER_URL, rubySource, (p) => (rubySource = p)) }],
        argv: ["ruby", RUBY_ADAPTER_PATH],
        launch: { ...common, entry: request.entry, root: SANDBOX_WORKDIR },
        setup: [],
        // The adapter's own command reader also blocks on a pipe, so it reports input waits itself.
        monitorInput: false,
      };
    default:
      throw new Error(`no debug adapter for ${request.language}`);
  }
}
