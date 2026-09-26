import type Docker from "dockerode";
import { expandCommand, requireLanguage, type ExecutionLimits, type ExecutionRequest, type ExecutionResult, type ExecutionStatus } from "@cw/shared";
import type { EventEmitter } from "./events.js";
import { classifyCompile, classifyRun, messageFor } from "./sandbox/classify.js";
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
}

/** Compiles (if the language needs it) and runs one request in a fresh sandbox. */
export async function runExecution(ctx: RunContext): Promise<ExecutionResult> {
  const { request, limits, events } = ctx;
  const lang = requireLanguage(request.language);
  const createdAt = new Date().toISOString();

  let stdout = "";
  let stderr = "";
  let compileOutput = "";
  const base = { id: ctx.executionId, language: lang.id, runtimeVersion: lang.version, createdAt };
  const finish = (status: ExecutionStatus, extra: Partial<ExecutionResult> = {}): ExecutionResult => ({
    ...base,
    status,
    stdout,
    stderr,
    compileOutput,
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
  });

  try {
    await sandbox.start();
    await sandbox.writeFiles(request.files);
    await sandbox.writeStdin(request.stdin ?? "");

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

    events.status("RUNNING");
    const argv = expandCommand(lang.runtime.command, { entry: request.entry, files: request.files });
    const run = await sandbox.runStep({
      argv,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      withStdin: true,
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
    const status = classifyRun(run);
    const memoryUsed = await sandbox.peakMemoryBytes();
    return finish(status, {
      exitCode: run.exitCode ?? undefined,
      executionTime: run.durationMs,
      compileTime,
      memoryUsed,
    });
  } catch (err) {
    ctx.log("sandbox failure", { error: err instanceof Error ? err.message : String(err) });
    return finish("SYSTEM_ERROR", { message: "The sandbox failed to start or crashed. This is not caused by your code; please retry." });
  } finally {
    await sandbox.dispose();
  }
}
