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
}

const STDIN_PATH = "/tmp/cw-stdin";
const PYTHON_ADAPTER_URL = new URL("../../debug-adapters/python/cw_debug_adapter.py", import.meta.url);
const PYTHON_ADAPTER_PATH = "/tmp/cwdbg/cw_debug_adapter.py";

let pythonSource: Promise<string> | null = null;

export async function debugAdapterFor(docker: Docker, request: ExecutionRequest): Promise<DebugAdapter> {
  const common = { stdinPath: STDIN_PATH, files: request.files.map((f) => f.path), breakpoints: request.breakpoints ?? {} };
  switch (request.language) {
    case "java": {
      const lang = requireLanguage("java");
      const mainClass = expandCommand(["{entryClass}"], { entry: request.entry, files: request.files })[0]!;
      // Program JVM flags mirror normal runs, with a heap cap so both JVMs fit.
      const vmOptions = lang.runtime.command.filter((a) => a.startsWith("-X")).concat("-Xmx192m").join(" ");
      return {
        files: await javaAdapterClasses(docker),
        argv: ["java", "-Xmx64m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xshare:auto", "-cp", ADAPTER_DIR, ADAPTER_MAIN],
        launch: { ...common, mainClass, classpath: "out", vmOptions },
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
      };
    }
    default:
      throw new Error(`no debug adapter for ${request.language}`);
  }
}
