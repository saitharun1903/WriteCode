import type Docker from "dockerode";
import type { Redis } from "ioredis";
import {
  INTERACTIVE_LIMITS,
  TEST_LIMITS,
  TRACE_LIMITS,
  expandCommand,
  requireLanguage,
  type ExecutionLimits,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatus,
  type TestRunResult,
  type Trace,
} from "@cw/shared";
import type { EventEmitter } from "./events.js";
import { classifyCompile, classifyRun, explainRuntimeError, messageFor, timeLimitMessage } from "./sandbox/classify.js";
import { INPUT_FIFO, InputChannel, applyInput, readCommands } from "./sandbox/input.js";
import { STDIN_PATH, Sandbox } from "./sandbox/sandbox.js";
import { tracerFor, type Tracer } from "./visualize/tracers.js";

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
  const { request, events } = ctx;
  const lang = requireLanguage(request.language);
  const createdAt = new Date().toISOString();
  const interactive = request.interactive === true && !!ctx.commandRedis;
  // Visualize mode runs the program under the language's tracer instead of its run command.
  const tracer: Tracer | null = request.mode === "visualize" ? await tracerFor(ctx.docker, request, interactive ? INPUT_FIFO : STDIN_PATH) : null;
  const limits = tracer ? tracer.limits(ctx.limits) : ctx.limits;
  const tests = request.mode === "test" ? (request.tests ?? []) : null;

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
    // Tracing uses the debugger's toolchain where the runtime image lacks it (gdb for C/C++).
    image: (tracer && lang.debugger?.image) || lang.runtime.image,
    executionId: ctx.executionId,
    limits,
    runtime: ctx.runtime,
    workspaceMb: ctx.workspaceMb,
    maxFileSizeBytes: ctx.maxFileSizeBytes,
    ...(interactive ? { lifetimeSeconds: Math.ceil((limits.compileTimeoutMs + INTERACTIVE_LIMITS.maxWallMs) / 1000) + 30 } : {}),
    ...(tests ? { lifetimeSeconds: Math.ceil((limits.compileTimeoutMs + tests.length * (limits.timeoutMs + TEST_STEP_MARGIN_MS + 1000)) / 1000) + 30 } : {}),
  });

  let reader: { stop: () => void } | null = null;
  try {
    events.status("STARTING");
    const startupBegan = performance.now();
    await sandbox.start();
    await sandbox.prepare(request.files, request.stdin ?? "", tracer?.files ?? []);
    for (const argv of tracer?.setup ?? []) await sandbox.exec(argv);
    if (interactive) await InputChannel.createFifo(sandbox);
    startupTime = Math.round(performance.now() - startupBegan);

    let compileTime: number | undefined;
    if (lang.compiler) {
      events.status("COMPILING");
      const argv = expandCommand((tracer && lang.debugger?.compiler) || lang.compiler.command, {
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

    if (tests) return finish("SUCCESS", { compileTime, ...(await runTests(ctx, sandbox, tests, limits)) });

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
    const argv = tracer ? tracer.argv : expandCommand(lang.runtime.command, { entry: request.entry, files: request.files });
    const run = await sandbox.runStep({
      argv,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
      stdin: tracer && !tracer.ownsStdin ? undefined : interactive ? "fifo" : "file",
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
    let traceNote: string | undefined;
    if (tracer) {
      const trace = await readTrace(sandbox, tracer);
      if (trace) events.trace(trace);
      else traceNote = "No trace was recorded: the program ended before the tracer could save it.";
    }
    // The cgroup peak includes the compiler (and the tracer), so it is only meaningful for plain interpreted runs.
    const memoryUsed = lang.compiler || tracer ? undefined : await sandbox.peakMemoryBytes();
    const message =
      traceNote ??
      (status === "TIME_LIMIT"
        ? timeLimitMessage(run.limit, limits, interactive ? INTERACTIVE_LIMITS : undefined)
        : status === "RUNTIME_ERROR"
          ? explainRuntimeError(run.exitCode, stderr, ctx.request.files)
          : undefined);
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

/** Extra time the worker allows a test before killing the sandbox; the in-sandbox `timeout` normally ends it first. */
const TEST_STEP_MARGIN_MS = 3000;

/**
 * Test mode: runs the compiled program once per input, each with the full run
 * time limit, enforced inside the sandbox with `timeout` so a test that runs
 * too long does not take the other tests down with it. Only a crash of the
 * sandbox itself (or cancelling) stops the remaining tests.
 */
async function runTests(ctx: RunContext, sandbox: Sandbox, inputs: string[], limits: ExecutionLimits): Promise<Partial<ExecutionResult>> {
  const lang = requireLanguage(ctx.request.language);
  const argv = expandCommand(lang.runtime.command, { entry: ctx.request.entry, files: ctx.request.files });
  const seconds = (limits.timeoutMs / 1000).toFixed(1);
  const results: TestRunResult[] = [];
  ctx.events.status("RUNNING");
  for (const [index, input] of inputs.entries()) {
    if (sandbox.isKilled) break;
    await sandbox.writeStdin(input);
    let stdout = "";
    let stderr = "";
    const run = await sandbox.runStep({
      argv: ["timeout", "-s", "KILL", seconds, ...argv],
      timeoutMs: limits.timeoutMs + TEST_STEP_MARGIN_MS,
      maxOutputBytes: TEST_LIMITS.maxOutputBytesPerTest,
      dropExcessOutput: true,
      stdin: "file",
      onStdout: (c) => void (stdout += c),
      onStderr: (c) => void (stderr += c),
      isCancelled: ctx.isCancelled,
    });
    // GNU timeout exits 124 when it stopped the program; older coreutils report the KILL (137) instead.
    const timedOut = run.timedOut || run.exitCode === 124 || (run.exitCode === 137 && run.durationMs >= limits.timeoutMs - 50);
    const status = classifyRun({ ...run, timedOut, outputLimited: false });
    const message =
      status === "TIME_LIMIT"
        ? `Stopped after ${limits.timeoutMs / 1000}s.`
        : status === "RUNTIME_ERROR"
          ? explainRuntimeError(run.exitCode, stderr, ctx.request.files)
          : run.outputLimited
            ? `Output after the first ${TEST_LIMITS.maxOutputBytesPerTest / 1024} KB was not kept.`
            : messageFor(status, limits);
    const result: TestRunResult = {
      index,
      status,
      stdout,
      stderr,
      exitCode: run.exitCode ?? undefined,
      executionTime: Math.min(run.durationMs, limits.timeoutMs),
      ...(message ? { message } : {}),
    };
    results.push(result);
    ctx.events.test(result);
    if (status === "CANCELLED") return { status: "CANCELLED", tests: results } as Partial<ExecutionResult>;
  }
  const executionTime = results.reduce((n, t) => n + (t.executionTime ?? 0), 0);
  if (results.length < inputs.length) {
    return { tests: results, executionTime, message: `The sandbox stopped after test ${results.length}; the remaining tests did not run.` };
  }
  return { tests: results, executionTime };
}

/** Reads and sanity-checks the trace the tracer wrote. The program shares the sandbox, so the file is untrusted. */
async function readTrace(sandbox: Sandbox, tracer: Tracer): Promise<Trace | null> {
  const text = await sandbox.readText(tracer.outPath, TRACE_LIMITS.maxTraceBytes + 64 * 1024);
  if (!text) return null;
  try {
    const trace = JSON.parse(text) as Trace;
    if (!Array.isArray(trace.steps) || typeof trace.stdout !== "string") return null;
    return trace;
  } catch {
    return null;
  }
}
