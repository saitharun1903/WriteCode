import type Docker from "dockerode";
import type { Redis } from "ioredis";
import {
  INTERACTIVE_LIMITS,
  expandCommand,
  requireLanguage,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatus,
} from "@cw/shared";
import type { EventEmitter } from "./events.js";
import { classifyCompile, classifyRun, explainRuntimeError, messageFor, timeLimitMessage } from "./sandbox/classify.js";
import { InputChannel, applyInput, readCommands } from "./sandbox/input.js";
import { Sandbox } from "./sandbox/sandbox.js";

export interface RunContext {
  docker: Docker;
  executionId: string;
  request: ExecutionRequest;
  limits: ExecutionLimits;
  runtime?: string;
  workspaceMb: number;
  maxFileSizeBytes: number;
  events: EventEmitter;
  isCancelled: () => Promise<boolean>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  /** Dedicated (blocking) connection for reading typed input; required for interactive runs. */
  commandRedis?: Redis;
}

/** Compiles (if the language needs it) and runs one request in a fresh sandbox. */
export async function runExecution(ctx: RunContext): Promise<ExecutionResult> {
  const { request, limits, events } = ctx;
  const lang = requireLanguage(request.language);
  const createdAt = new Date().toISOString();
  const interactive = request.interactive === true && !!ctx.commandRedis;

  let stdout = "";
  let stderr = "";
  let compileOutput = "";
  let startupTime: number | undefined;
  const base = { id: ctx.executionId, language: lang.id, runtimeVersion: lang.version, createdAt };
  const finish = (status: ExecutionStatus, extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
    ...base,
    status,
    stdout,
    stderr,
    compileOutput,
    startupTime,
    message: extra.message ?? messageFor(status, limits),
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
    ...(interactive ? { lifetimeSeconds: Math.ceil((limits.compileTimeoutMs + INTERACTIVE_LIMITS.maxWallMs) / 1000) + 30 } : {}),
  });

  let reader: { stop: () => void } | null = null;
  try {
    events.status("STARTING");
    const startupBegan = performance.now();
    await sandbox.start();
    await sandbox.prepare(request.files, request.stdin ?? "");
    if (interactive) await InputChannel.createFifo(sandbox);
    startupTime = Math.round(performance.now() - startupBegan);

    let compileTime: number | undefined;
    if (lang.compiler) {
      events.status("COMPILING");
      const argv = expandCommand(lang.compiler.command, {
        entry: request.entry,
        files: request.files,
        sourceExtensions: lang.compiler.sourceExtensions,
      });
      const compile = await sandbox.runStep({
        argv,
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

    let channel: InputChannel | null = null;
    if (interactive) {
      channel = await InputChannel.start(sandbox, {
        onWaiting: (waiting) => events.status(waiting ? "WAITING_FOR_INPUT" : "RUNNING"),
        onEcho: (text) => events.chunk("stdin", text),
      });
      const ch = channel;
      reader = readCommands(ctx.commandRedis!, ctx.executionId, (payload) => void applyInput(payload, ch));
    }

    events.status("RUNNING");
    const argv = expandCommand(lang.runtime.command, { entry: request.entry, files: request.files });
    const run = await sandbox.runStep({
      argv,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      stdin: interactive ? "fifo" : "file",
      ...(channel
        ? {
            clock: {
              waiting: () => channel.detection && channel.waiting,
              maxInputWaitMs: INTERACTIVE_LIMITS.maxInputWaitMs,
              // Without wait detection, input waits count as run time; allow the whole interactive window.
              maxWallMs: INTERACTIVE_LIMITS.maxWallMs,
            },
          }
        : {}),
      onStdout: (c) => {
        stdout += c;
        events.chunk("stdout", c);
      },
      onStderr: (c) => {
        stderr += c;
        events.chunk("stderr", c);
      },
      isCancelled: ctx.isCancelled,
    });
    if (channel && !channel.detection) ctx.log("input wait detection unavailable; typed-input waits counted as run time");
    const status = classifyRun(run);
    // The cgroup peak includes the compiler, so it is only meaningful for interpreted languages.
    const memoryUsed = lang.compiler ? undefined : await sandbox.peakMemoryBytes();
    const message =
      status === "TIME_LIMIT"
        ? timeLimitMessage(run.limit, limits, interactive ? INTERACTIVE_LIMITS : undefined)
        : status === "RUNTIME_ERROR"
          ? explainRuntimeError(run.exitCode, stderr)
          : undefined;
    return finish(status, {
      exitCode: run.exitCode ?? undefined,
      executionTime: run.durationMs,
      compileTime,
      memoryUsed,
      ...(message ? { message } : {}),
    });
  } catch (err) {
    ctx.log("sandbox failure", { error: err instanceof Error ? err.message : String(err) });
    return finish("SYSTEM_ERROR", { message: "The sandbox failed to start or crashed. This is not caused by your code; please retry." });
  } finally {
    reader?.stop();
    // Remove in the background so the result is not delayed; the startup sweep catches failures.
    void sandbox.dispose();
  }
}
