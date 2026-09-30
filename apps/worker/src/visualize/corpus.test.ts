import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionResult, Trace } from "@cw/shared";
import { config } from "../config.js";
import { createDocker } from "../docker.js";
import type { EventEmitter } from "../events.js";
import { runExecution } from "../runner.js";

/**
 * Records visualizer traces for a folder of programs (VIZ_CORPUS=<dir>):
 * `<name>.py|js|ts|c|cpp` files and `<name>/Main.java` folders. Traces are written to
 * `<dir>/traces/<name>.json` for the web app's structure tests to replay.
 */
const dir = process.env.VIZ_CORPUS;
const docker = createDocker(config.dockerHost);

async function record(language: string, files: Record<string, string>): Promise<{ result: ExecutionResult; trace?: Trace }> {
  let trace: Trace | undefined;
  const events = { status() {}, chunk() {}, debug() {}, trace: (t: Trace) => (trace = t), async result() {} } as unknown as EventEmitter;
  const result = await runExecution({
    docker,
    executionId: randomUUID(),
    request: { language, files: Object.entries(files).map(([path, content]) => ({ path, content })), entry: Object.keys(files)[0]!, stdin: "3\n1 2 3\n", mode: "visualize" },
    limits: config.limits,
    workspaceMb: config.workspaceMb,
    maxFileSizeBytes: config.maxFileSizeBytes,
    events,
    isCancelled: async () => false,
    log: () => {},
  });
  return { result, trace };
}

describe.skipIf(!dir)("visualizer corpus", () => {
  const only = process.env.VIZ_ONLY ? new RegExp(process.env.VIZ_ONLY) : null;
  const entries = (dir ? readdirSync(dir).filter((n) => /\.(py|js|ts|c|cpp)$/.test(n) || (statSync(join(dir, n)).isDirectory() && n !== "traces")) : []).filter((n) => !only || only.test(n));
  if (dir) mkdirSync(join(dir, "traces"), { recursive: true });
  it.concurrent.each(entries)("%s", { timeout: 180_000 }, async (name) => {
    const ext = /\.(py|js|ts|c|cpp)$/.exec(name)?.[1];
    const language = ({ py: "python", js: "javascript", ts: "typescript", c: "c", cpp: "cpp" } as Record<string, string>)[ext ?? ""] ?? "java";
    const files: Record<string, string> = ext ? { [`main.${ext}`]: readFileSync(join(dir!, name), "utf8") } : { "Main.java": readFileSync(join(dir!, name, "Main.java"), "utf8") };
    const { result, trace } = await record(language, files);
    expect(trace, `${name}: ${result.status} ${result.message ?? ""}`).toBeTruthy();
    writeFileSync(join(dir!, "traces", `${name.replace(/\.(py|js|ts|c|cpp)$/, "")}.json`), JSON.stringify(trace));
    if (process.env.VIZ_ONLY) writeFileSync(join(dir!, "traces", `${name}.result.json`), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }));
  });
});
