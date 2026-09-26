import { readFile } from "node:fs/promises";
import type Docker from "dockerode";
import { DEFAULT_LIMITS, requireLanguage } from "@cw/shared";
import type { SandboxFile } from "../sandbox/files.js";
import { Sandbox } from "../sandbox/sandbox.js";

/** Where adapter classes are placed inside a debug sandbox. */
export const ADAPTER_DIR = "/tmp/cwdbg";
export const ADAPTER_MAIN = "CwDebugAdapter";

const SOURCE_URL = new URL("../../debug-adapters/java/CwDebugAdapter.java", import.meta.url);

let cached: Promise<SandboxFile[]> | null = null;

/**
 * Compiles the Java debug adapter once per worker process, inside a sandbox
 * built from the same JDK image, and returns its class files for reuse.
 */
export function javaAdapterClasses(docker: Docker): Promise<SandboxFile[]> {
  cached ??= compile(docker).catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

async function compile(docker: Docker): Promise<SandboxFile[]> {
  const source = await readFile(SOURCE_URL, "utf8");
  const image = requireLanguage("java").runtime.image;
  const sandbox = new Sandbox(docker, {
    image,
    executionId: "debug-adapter-build",
    limits: { ...DEFAULT_LIMITS, memoryMb: 512 },
    workspaceMb: 64,
    maxFileSizeBytes: 16 * 1024 * 1024,
  });
  try {
    await sandbox.start();
    await sandbox.prepare([{ path: "adapter/CwDebugAdapter.java", content: source }], "");
    let log = "";
    const res = await sandbox.runStep({
      argv: ["javac", "--release", "21", "-J-XX:+UseSerialGC", "-d", "adapter/classes", "adapter/CwDebugAdapter.java"],
      timeoutMs: 60_000,
      maxOutputBytes: 64 * 1024,
      onStdout: (c) => (log += c),
      onStderr: (c) => (log += c),
      isCancelled: async () => false,
    });
    if (res.exitCode !== 0) throw new Error(`debug adapter failed to compile: ${log.slice(0, 1000)}`);

    let listing = "";
    await sandbox.runStep({
      argv: ["sh", "-c", 'cd adapter/classes && for f in *.class; do printf "%s %s\\n" "$f" "$(base64 -w0 "$f")"; done'],
      timeoutMs: 20_000,
      maxOutputBytes: 8 * 1024 * 1024,
      onStdout: (c) => (listing += c),
      onStderr: () => {},
      isCancelled: async () => false,
    });
    const files = listing
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, b64] = line.split(" ");
        return { path: `${ADAPTER_DIR}/${name}`, content: b64 ?? "", base64: true } satisfies SandboxFile;
      });
    if (!files.some((f) => f.path.endsWith(`/${ADAPTER_MAIN}.class`))) throw new Error("debug adapter classes missing after compile");
    return files;
  } finally {
    await sandbox.dispose();
  }
}
