import type Docker from "dockerode";
import type { Redis } from "ioredis";
import {
  parseDebugCommand,
  requireLanguage,
  type DebugCommand,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatus,
  type StopReason,
} from "@cw/shared";
import type { EventEmitter } from "../events.js";
import { classifyCompile, explainRuntimeError } from "../sandbox/classify.js";
import { compileProgram } from "../sandbox/compile.js";
import { INPUT_FIFO, InputChannel, applyInput, readCommands } from "../sandbox/input.js";
import { Sandbox } from "../sandbox/sandbox.js";
import { debugAdapterFor, type DebugAdapter } from "./adapters.js";

export const DEBUG_SESSION_LIMITS = {
  /** Hard cap on a session's total lifetime. */
  maxSessionMs: 15 * 60_000,
  /** End the session when no command arrives for this long. */
  idleMs: 10 * 60_000,
  /** Cumulative time the program may run while not paused. */
  runBudgetMs: 30_000,
  /** The adapter must answer the launch request within this time. */
  launchTimeoutMs: 60_000,
  /** Java runs two JVMs (adapter + program) in the sandbox. */
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
  const limits: ExecutionLimits = { ...ctx.limits, memoryMb: Math.max(DEBUG_SESSION_LIMITS.memoryMb, lang.sandbox?.memoryMb ?? 0), pids: DEBUG_SESSION_LIMITS.pids };

  let stdout = "";
  let stderr = "";
  let compileOutput = "";
  let outputBytes = 0;
  let startupTime: number | undefined;
  const interactive = request.interactive === true;
  const finish = (status: ExecutionStatus, extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
    id: ctx.executionId,
    language: lang.id,
    runtimeVersion: lang.version,
    createdAt,
    status,
    stdout,
    stderr,
    compileOutput,
    startupTime,
    finishedAt: new Date().toISOString(),
    ...extra,
  });

  const sandbox = new Sandbox(ctx.docker, {
    image: lang.debugger?.image ?? lang.runtime.image,
    executionId: ctx.executionId,
    limits,
    runtime: ctx.runtime,
    workspaceMb: ctx.workspaceMb,
    maxFileSizeBytes: ctx.maxFileSizeBytes,
    lifetimeSeconds: Math.ceil(DEBUG_SESSION_LIMITS.maxSessionMs / 1000) + 60,
  });

  try {
    events.status("STARTING");
    const startupBegan = performance.now();
    const adapter = await debugAdapterFor(ctx.docker, request, interactive ? INPUT_FIFO : undefined);
    await sandbox.start();
    await sandbox.prepare(request.files, request.stdin ?? "", adapter.files);
    for (const argv of adapter.setup) await sandbox.exec(argv);
    if (interactive) await InputChannel.createFifo(sandbox);
    startupTime = Math.round(performance.now() - startupBegan);

    let compileTime: number | undefined;
    if (lang.compiler) {
      events.status("COMPILING");
      const compile = await compileProgram(sandbox, lang, request, lang.debugger?.compiler ?? lang.compiler.command, limits, ctx.isCancelled);
      compileOutput = compile.output;
      if (compileOutput) events.chunk("compile", compileOutput);
      compileTime = compile.durationMs;
      const failed = classifyCompile(compile.step);
      if (failed) return finish(failed.status, { compileTime, message: failed.message, exitCode: compile.step.exitCode ?? undefined });
    }

    const channel = interactive
      ? await InputChannel.start(
          sandbox,
          {
            onWaiting: (waiting) => events.status(waiting ? "WAITING_FOR_INPUT" : "RUNNING"),
            onEcho: (text) => events.chunk("stdin", text),
          },
          { monitor: adapter.monitorInput },
        )
      : null;

    events.status("RUNNING");
    return await drive(ctx, sandbox, adapter, channel, limits, compileTime, {
      onStdout: (c) => (stdout += c),
      onStderr: (c) => (stderr += c),
      account: (n) => (outputBytes += n) <= limits.maxOutputBytes,
      stderr: () => stderr,
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
  debugAdapter: DebugAdapter,
  channel: InputChannel | null,
  limits: ExecutionLimits,
  compileTime: number | undefined,
  out: {
    onStdout: (c: string) => void;
    onStderr: (c: string) => void;
    account: (bytes: number) => boolean;
    stderr: () => string;
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

  let paused = false;
  // Budget time counts only while the program runs: not while paused, and not while it waits for typed input.
  const startRunning = () => {
    if (runningSince === null && !paused && !channel?.waiting) runningSince = Date.now();
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
          paused = true;
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
          paused = false;
          startRunning();
          events.debug({ kind: "continued" });
          return;
        case "breakpoints":
          events.debug({ kind: "breakpoints", file: String(msg.file), breakpoints: (msg.breakpoints as never) ?? [] });
          return;
        case "input": {
          // The adapter saw the program block on (or return from) a stdin read.
          channel?.reportWaiting(msg.waiting === true);
          if (msg.waiting === true) stopRunning();
          else startRunning();
          return;
        }
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
      clearTimeout(launchTimer);
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

  const adapter = await sandbox.startInteractive(debugAdapter.argv, {
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
  });
  void adapter.exited.then(() => end(endStatus?.status ?? "SYSTEM_ERROR", endStatus?.message ?? "The debugger stopped unexpectedly."));

  const send = (command: { cmd: string; [key: string]: unknown }, requestId?: string) => {
    const s = ++seq;
    pending.set(s, { requestId, command });
    adapter.write(JSON.stringify({ seq: s, ...command }) + "\n");
  };

  send({ cmd: "launch", ...debugAdapter.launch });
  const launchTimer = setTimeout(() => end("SYSTEM_ERROR", "The debugger did not start in time. Please retry."), DEBUG_SESSION_LIMITS.launchTimeoutMs);
  startRunning();
  // The kernel monitor (when used) reports waits through the channel.
  const onChannelWait = setInterval(() => {
    if (channel?.waiting) stopRunning();
    else startRunning();
  }, 100);

  // Relay client commands and typed input from Redis until the session ends.
  const reader = readCommands(ctx.commandRedis, ctx.executionId, (payload) => {
    if (applyInput(payload, channel)) {
      lastActivity = Date.now();
      return;
    }
    const command = parseDebugCommand(payload.command);
    if (!command) return;
    lastActivity = Date.now();
    if (command.cmd === "terminate") {
      end("CANCELLED", "Debug session stopped.");
      return;
    }
    if (command.cmd === "setBreakpoints" && !request.files.some((f) => f.path === command.file)) return;
    send(command, typeof payload.requestId === "string" ? payload.requestId : undefined);
  });

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
  clearInterval(onChannelWait);
  clearTimeout(launchTimer);
  reader.stop();
  // The adapter and program live only in this sandbox; killing it ends the session at once.
  await sandbox.kill();

  const final = endStatus ?? { status: "SYSTEM_ERROR" as ExecutionStatus, message: "The debugger stopped unexpectedly." };
  return out.finish(final.status, {
    compileTime,
    exitCode: exitCode ?? undefined,
    executionTime: runSpent + (runningSince !== null ? Date.now() - runningSince : 0),
    message: final.message ?? (final.status === "RUNTIME_ERROR" ? explainRuntimeError(exitCode, out.stderr(), ctx.request.files) : undefined),
  });
}
