import type Docker from "dockerode";
import type { Redis } from "ioredis";
import {
  STREAM_FIELD,
  expandCommand,
  parseDebugCommand,
  redisKeys,
  requireLanguage,
  type DebugCommand,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatus,
  type StopReason,
} from "@cw/shared";
import type { EventEmitter } from "../events.js";
import { classifyCompile } from "../sandbox/classify.js";
import { Sandbox } from "../sandbox/sandbox.js";
import { ADAPTER_DIR, ADAPTER_MAIN, javaAdapterClasses } from "./java-adapter.js";

export const DEBUG_SESSION_LIMITS = {
  /** Hard cap on a session's total lifetime. */
  maxSessionMs: 15 * 60_000,
  /** End the session when no command arrives for this long. */
  idleMs: 10 * 60_000,
  /** Cumulative time the program may run while not paused. */
  runBudgetMs: 30_000,
  /** Two JVMs (adapter + program) share the sandbox. */
  memoryMb: 512,
  pids: 256,
};

export interface DebugContext {
  docker: Docker;
  /** Dedicated connection: the command reader blocks on it. */
  commandRedis: Redis;
  executionId: string;
  request: ExecutionRequest;
  limits: ExecutionLimits;
  runtime?: string;
  workspaceMb: number;
  maxFileSizeBytes: number;
  events: EventEmitter;
  isCancelled: () => Promise<boolean>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

interface AdapterMessage {
  type: "response" | "event";
  requestSeq?: number;
  success?: boolean;
  message?: string;
  event?: string;
  [key: string]: unknown;
}

/** Commands whose responses the client waits on (the rest are fire-and-forget). */
const RESPONDING = new Set<DebugCommand["cmd"]>(["variables", "evaluate", "setBreakpoints"]);

/**
 * Runs one interactive debug session: compile with debug info, launch the
 * program under the in-sandbox adapter, relay client commands from a Redis
 * stream, and publish adapter events. Ends when the program exits, the client
 * stops it, or a session limit is hit.
 */
export async function runDebugSession(ctx: DebugContext): Promise<ExecutionResult> {
  const { request, events } = ctx;
  const lang = requireLanguage(request.language);
  const createdAt = new Date().toISOString();
  const limits: ExecutionLimits = { ...ctx.limits, memoryMb: DEBUG_SESSION_LIMITS.memoryMb, pids: DEBUG_SESSION_LIMITS.pids };

  let stdout = "";
  let stderr = "";
  let compileOutput = "";
  let outputBytes = 0;
  const finish = (status: ExecutionStatus, extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
    id: ctx.executionId,
    language: lang.id,
    runtimeVersion: lang.version,
    createdAt,
    status,
    stdout,
    stderr,
    compileOutput,
    finishedAt: new Date().toISOString(),
    ...extra,
  });

  const sandbox = new Sandbox(ctx.docker, {
    image: lang.runtime.image,
    executionId: ctx.executionId,
    limits,
    runtime: ctx.runtime,
    workspaceMb: ctx.workspaceMb,
    maxFileSizeBytes: ctx.maxFileSizeBytes,
    lifetimeSeconds: Math.ceil(DEBUG_SESSION_LIMITS.maxSessionMs / 1000) + 60,
  });

  try {
    const adapterFiles = await javaAdapterClasses(ctx.docker);
    await sandbox.start();
    await sandbox.prepare(request.files, request.stdin ?? "", adapterFiles);

    let compileTime: number | undefined;
    if (lang.compiler) {
      events.status("COMPILING");
      const compile = await sandbox.runStep({
        argv: expandCommand(lang.compiler.command, { entry: request.entry, files: request.files, sourceExtensions: lang.compiler.sourceExtensions }),
        timeoutMs: limits.compileTimeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        onStdout: (c) => {
          compileOutput += c;
          events.chunk("compile", c);
        },
        onStderr: (c) => {
          compileOutput += c;
          events.chunk("compile", c);
        },
        isCancelled: ctx.isCancelled,
      });
      compileTime = compile.durationMs;
      const failed = classifyCompile(compile);
      if (failed) return finish(failed.status, { compileTime, message: failed.message, exitCode: compile.exitCode ?? undefined });
    }

    events.status("RUNNING");
    return await drive(ctx, sandbox, limits, compileTime, {
      onStdout: (c) => (stdout += c),
      onStderr: (c) => (stderr += c),
      account: (n) => (outputBytes += n) <= limits.maxOutputBytes,
      finish,
    });
  } catch (err) {
    ctx.log("debug session failure", { error: err instanceof Error ? err.message : String(err) });
    return finish("SYSTEM_ERROR", { message: "The debugger failed to start. This is not caused by your code; please retry." });
  } finally {
    void sandbox.dispose();
  }
}

async function drive(
  ctx: DebugContext,
  sandbox: Sandbox,
  limits: ExecutionLimits,
  compileTime: number | undefined,
  out: {
    onStdout: (c: string) => void;
    onStderr: (c: string) => void;
    account: (bytes: number) => boolean;
    finish: (status: ExecutionStatus, extra?: Partial<ExecutionResult>) => ExecutionResult;
  },
): Promise<ExecutionResult> {
  const { request, events } = ctx;
  const started = Date.now();
  let lastActivity = Date.now();
  let runningSince: number | null = null;
  let runSpent = 0;
  let exitCode: number | null | undefined;
  let endStatus: { status: ExecutionStatus; message?: string } | null = null;

  // Adapter request sequencing: map adapter seq -> client request.
  let seq = 0;
  const pending = new Map<number, { requestId?: string; command: { cmd: string } }>();

  let buffer = "";
  let resolveEnded!: () => void;
  const ended = new Promise<void>((r) => (resolveEnded = r));
  const end = (status: ExecutionStatus, message?: string) => {
    if (!endStatus) endStatus = { status, message };
    resolveEnded();
  };

  const startRunning = () => {
    if (runningSince === null) runningSince = Date.now();
  };
  const stopRunning = () => {
    if (runningSince !== null) runSpent += Date.now() - runningSince;
    runningSince = null;
  };

  const onAdapterMessage = (msg: AdapterMessage) => {
    if (msg.type === "event") {
      switch (msg.event) {
        case "output": {
          const text = String(msg.text ?? "");
          if (!out.account(Buffer.byteLength(text))) {
            end("OUTPUT_LIMIT", `Stopped after printing more than ${Math.round(limits.maxOutputBytes / 1000)} KB of output.`);
            return;
          }
          if (msg.stream === "stderr") {
            out.onStderr(text);
            events.chunk("stderr", text);
          } else {
            out.onStdout(text);
            events.chunk("stdout", text);
          }
          return;
        }
        case "stopped":
          stopRunning();
          events.debug({
            kind: "stopped",
            reason: msg.reason as StopReason,
            thread: String(msg.thread),
            frames: (msg.frames as never) ?? [],
            description: msg.description as string | undefined,
          });
          return;
        case "continued":
          startRunning();
          events.debug({ kind: "continued" });
          return;
        case "breakpoints":
          events.debug({ kind: "breakpoints", file: String(msg.file), breakpoints: (msg.breakpoints as never) ?? [] });
          return;
        case "exited":
          exitCode = typeof msg.exitCode === "number" ? msg.exitCode : null;
          end(exitCode === 0 ? "SUCCESS" : "RUNTIME_ERROR");
          return;
        case "error":
          ctx.log("adapter error", { message: msg.message });
          return;
      }
      return;
    }
    // Response to one of our requests.
    const req = msg.requestSeq !== undefined ? pending.get(msg.requestSeq) : undefined;
    if (!req) return;
    pending.delete(msg.requestSeq!);
    if (req.command.cmd === "launch") {
      if (msg.success === false) end("SYSTEM_ERROR", `The debugger could not start the program: ${msg.message ?? "unknown error"}`);
      return;
    }
    const cmd = req.command.cmd as DebugCommand["cmd"];
    if (!req.requestId || !RESPONDING.has(cmd)) {
      if (msg.success === false) events.debug({ kind: "response", requestId: req.requestId ?? "", command: cmd, success: false, message: msg.message });
      return;
    }
    events.debug({
      kind: "response",
      requestId: req.requestId,
      command: cmd,
      success: msg.success !== false,
      message: msg.message,
      ref: msg.ref as number | undefined,
      variables: msg.variables as never,
      expression: msg.expression as string | undefined,
      result: msg.result as never,
      error: msg.error as string | undefined,
    });
  };

  const adapter = await sandbox.startInteractive(
    ["java", "-Xmx64m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xshare:auto", "-cp", ADAPTER_DIR, ADAPTER_MAIN],
    {
      onStdout: (chunk) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            onAdapterMessage(JSON.parse(line) as AdapterMessage);
          } catch {
            ctx.log("unparseable adapter output", { line: line.slice(0, 200) });
          }
        }
      },
      onStderr: (chunk) => ctx.log("adapter stderr", { text: chunk.slice(0, 500) }),
    },
  );
  void adapter.exited.then(() => end(endStatus?.status ?? "SYSTEM_ERROR", endStatus?.message ?? "The debugger stopped unexpectedly."));

  const send = (command: { cmd: string; [key: string]: unknown }, requestId?: string) => {
    const s = ++seq;
    pending.set(s, { requestId, command });
    adapter.write(JSON.stringify({ seq: s, ...command }) + "\n");
  };

  const lang = requireLanguage(request.language);
  const entryClass = expandCommand(["{entryClass}"], { entry: request.entry, files: request.files })[0]!;
  // Program JVM flags mirror normal runs, with a heap cap so both JVMs fit.
  const vmOptions = lang.runtime.command.filter((a) => a.startsWith("-X")).concat("-Xmx192m").join(" ");
  send({
    cmd: "launch",
    mainClass: entryClass,
    classpath: "out",
    vmOptions,
    stdinPath: "/tmp/cw-stdin",
    files: request.files.map((f) => f.path),
    breakpoints: request.breakpoints ?? {},
  });
  startRunning();

  // Relay client commands from Redis until the session ends.
  let reading = true;
  const reader = (async () => {
    let lastId = "0-0";
    const key = redisKeys.commands(ctx.executionId);
    while (reading) {
      const res = (await ctx.commandRedis.xread("BLOCK", 1000, "STREAMS", key, lastId).catch(() => null)) as
        | [string, [string, string[]][]][]
        | null;
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          lastId = id;
          const idx = fields.indexOf(STREAM_FIELD);
          if (idx === -1) continue;
          let payload: { requestId?: string; command?: unknown };
          try {
            payload = JSON.parse(fields[idx + 1]!) as typeof payload;
          } catch {
            continue;
          }
          const command = parseDebugCommand(payload.command);
          if (!command) continue;
          lastActivity = Date.now();
          if (command.cmd === "terminate") {
            end("CANCELLED", "Debug session stopped.");
            continue;
          }
          if (command.cmd === "setBreakpoints" && !request.files.some((f) => f.path === command.file)) continue;
          send(command, payload.requestId);
        }
      }
    }
  })();

  // Enforce session limits and cancellation.
  const watchdog = setInterval(() => {
    const now = Date.now();
    const spent = runSpent + (runningSince !== null ? now - runningSince : 0);
    if (spent > DEBUG_SESSION_LIMITS.runBudgetMs) {
      end("TIME_LIMIT", `The program ran for more than ${DEBUG_SESSION_LIMITS.runBudgetMs / 1000}s without pausing and was stopped.`);
    } else if (now - started > DEBUG_SESSION_LIMITS.maxSessionMs) {
      end("TIME_LIMIT", `Debug sessions are limited to ${DEBUG_SESSION_LIMITS.maxSessionMs / 60_000} minutes.`);
    } else if (now - lastActivity > DEBUG_SESSION_LIMITS.idleMs) {
      end("CANCELLED", "The debug session ended after being idle.");
    }
    void ctx.isCancelled().then((c) => c && end("CANCELLED", "Debug session stopped."));
  }, 500);

  await ended;
  clearInterval(watchdog);
  reading = false;
  // Both JVMs live only in this sandbox; killing it ends the session at once.
  await sandbox.kill();
  // The reader exits on its own once the caller disconnects its blocking connection.
  void reader;

  const final = endStatus ?? { status: "SYSTEM_ERROR" as ExecutionStatus, message: "The debugger stopped unexpectedly." };
  return out.finish(final.status, {
    compileTime,
    exitCode: exitCode ?? undefined,
    executionTime: runSpent + (runningSince !== null ? Date.now() - runningSince : 0),
    message: final.message,
  });
}
