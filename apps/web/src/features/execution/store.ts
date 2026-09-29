"use client";

import { create } from "zustand";
import {
  anyFileIsRunnable,
  findEntryPoints,
  isTerminalStatus,
  parseDiagnostics,
  type DebugCommand,
  type Diagnostic,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionStatus,
  type Project,
} from "@cw/shared";
import { historyRepo } from "@/features/projects/db";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { createId } from "@/lib/id";
import { useDebug } from "@/features/debug/store";
import { useVisualize } from "@/features/visualize/store";
import { ApiError, api, streamExecution, waitForResult, type ExecutionStream } from "./api";

export type RunnerStatus = "unknown" | "online" | "offline" | "unavailable";
export type LogStream = "stdout" | "stderr" | "compile" | "stdin" | "system";

export interface LogChunk {
  stream: LogStream;
  text: string;
}

export interface RunState {
  id?: string;
  projectId: string;
  /** Entry file the run was started with. */
  entry: string;
  mode: ExecutionMode;
  /** The program's stdin stays open for typed input (no prepared input was given). */
  interactive: boolean;
  /** Typed input was closed with end-of-file. */
  inputClosed?: boolean;
  /** Last problem sending typed input. */
  inputError?: string;
  /** SUBMITTING covers the gap between clicking Run and the server accepting the job. */
  status: ExecutionStatus | "SUBMITTING";
  log: LogChunk[];
  result?: ExecutionResult;
  /** Client-side failure (network, validation). Distinct from program errors. */
  error?: { title: string; detail?: string; requestId?: string };
  startedAt: number;
}

interface ExecutionState {
  runner: RunnerStatus;
  runnerReason?: string;
  run: RunState | null;
  diagnostics: Diagnostic[];
  /** Bumped whenever history changes so the history view can refetch. */
  historyVersion: number;

  checkHealth: () => Promise<void>;
  /**
   * Runs or debugs the project's entry file. `entry` runs another file and
   * remembers it as the entry. When the entry file has no entry point and
   * several files do, asks which one to run instead of guessing.
   */
  execute: (options?: { mode?: ExecutionMode; entry?: string }) => Promise<void>;
  /** Sends a line (or raw text) of input to the running program; `eof` closes its stdin. */
  sendInput: (text: string, eof?: boolean) => void;
  cancel: () => Promise<void>;
  clearOutput: () => void;
  bumpHistory: () => void;
  /** Leaves the current run behind (its project was closed): stops it on the server and clears the console. */
  abandon: () => void;
}

const MAX_LOG_CHARS = 1_200_000;
/** Beyond this many chunks, output joins the last one so the console stays fast. */
const MAX_LOG_CHUNKS = 4000;
let stream: ExecutionStream | null = null;
/** Set from the click until the run is accepted, so a double press starts one run. */
let starting = false;
/** Stop was pressed before the server accepted the run; cancel it as soon as it has an id. */
let cancelRequested = false;

/** Called when the project's entry file has no entry point and several others do. Set by the UI. */
export const entryChooser: { open: ((mode: ExecutionMode) => void) | null } = { open: null };

/** Sends a command to the active debug session over its event socket. */
export function sendDebugCommand(requestId: string, command: DebugCommand): boolean {
  return stream?.sendDebug(requestId, command) ?? false;
}

/** Characters in each log array, so appending does not re-count the whole log. */
const logSizes = new WeakMap<LogChunk[], number>();

function logSize(log: LogChunk[]): number {
  let n = logSizes.get(log);
  if (n === undefined) {
    n = log.reduce((sum, c) => sum + c.text.length, 0);
    logSizes.set(log, n);
  }
  return n;
}

function appendLogs(log: LogChunk[], chunks: LogChunk[]): LogChunk[] {
  let total = logSize(log);
  if (total > MAX_LOG_CHARS || !chunks.length) return log;
  const next = log.slice();
  for (const chunk of chunks) {
    if (total > MAX_LOG_CHARS) break;
    const last = next[next.length - 1];
    if (last && (last.stream === chunk.stream || next.length >= MAX_LOG_CHUNKS)) next[next.length - 1] = { stream: last.stream, text: last.text + chunk.text };
    else next.push(chunk);
    total += chunk.text.length;
  }
  logSizes.set(next, total);
  return next;
}

// Output arrives in many small pieces (every switch between stdout and stderr is one);
// they are applied together a few times a second instead of re-rendering the console for each.
let pendingLog: { id: string; chunks: LogChunk[] } | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** Breakpoints for files that still exist, in the shape the API expects. */
function liveBreakpoints(project: Project): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [file, lines] of Object.entries(project.breakpoints ?? {})) {
    if (lines.length && project.files.some((f) => f.path === file)) out[file] = lines;
  }
  return out;
}

function snapshotFiles(project: Project) {
  return project.files.map((f) => ({ path: f.path, content: f.content }));
}

export const useExecution = create<ExecutionState>((set, get) => {
  const flushLog = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    const batch = pendingLog;
    pendingLog = null;
    if (!batch) return;
    set((s) => (s.run && s.run.id === batch.id ? { run: { ...s.run, log: appendLogs(s.run.log, batch.chunks) } } : s));
  };

  const queueLog = (id: string, chunk: LogChunk) => {
    if (pendingLog && pendingLog.id !== id) flushLog();
    (pendingLog ??= { id, chunks: [] }).chunks.push(chunk);
    pendingTimer ??= setTimeout(flushLog, 40);
  };

  const finish = async (result: ExecutionResult, project: Project) => {
    flushLog();
    stream?.close();
    stream = null;
    if (get().run?.mode === "debug") useDebug.getState().onEnded();
    const files = project.files.map((f) => f.path);
    const diagnostics = [
      ...parseDiagnostics(result.language, result.compileOutput, files),
      ...parseDiagnostics(result.language, result.stderr, files),
    ];
    set((s) => ({
      run: s.run && s.run.id === result.id ? { ...s.run, status: result.status, result } : s.run,
      diagnostics,
    }));
    if (useSettings.getState().recordHistory) {
      try {
        await historyRepo.add({
          id: createId(),
          projectId: project.id,
          projectName: project.name,
          language: project.language,
          entryFile: project.entryFile,
          files: snapshotFiles(project),
          stdin: project.stdin,
          result,
          createdAt: Date.now(),
        });
        get().bumpHistory();
      } catch {
        // History is best-effort; the run result is already on screen.
      }
    }
  };

  const fail = (title: string, detail?: string, requestId?: string) => {
    flushLog();
    stream?.close();
    stream = null;
    if (get().run?.mode === "debug") useDebug.getState().onEnded();
    set((s) => ({ run: s.run ? { ...s.run, status: "SYSTEM_ERROR", error: { title, detail, requestId } } : s.run }));
  };

  return {
    runner: "unknown",
    run: null,
    diagnostics: [],
    historyVersion: 0,

    async checkHealth() {
      try {
        const h = await api.health(AbortSignal.timeout(4000));
        set({ runner: h.runner.available ? "online" : "unavailable", runnerReason: h.runner.reason });
      } catch {
        set({ runner: "offline", runnerReason: "The API server is not reachable." });
      }
    },

    async execute(options) {
      const mode = options?.mode ?? "run";
      if (starting || isRunning(get().run)) return;
      starting = true;
      try {
        await start(mode, options?.entry);
      } finally {
        starting = false;
      }
    },

    async cancel() {
      const run = get().run;
      if (!run?.id) {
        // Still being accepted: cancel it the moment the server gives it an id.
        if (run?.status === "SUBMITTING") cancelRequested = true;
        return;
      }
      try {
        await api.cancelExecution(run.id);
      } catch {
        // The result event (CANCELLED or otherwise) is authoritative; nothing to do here.
      }
    },

    sendInput(text, eof = false) {
      const run = get().run;
      if (!run?.id || !run.interactive || run.inputClosed || !isRunning(run)) return;
      if (!stream?.sendInput(text, eof)) {
        set((s) => ({ run: s.run ? { ...s.run, inputError: "Not connected to the program." } : s.run }));
        return;
      }
      set((s) => ({ run: s.run ? { ...s.run, inputError: undefined, inputClosed: eof || s.run.inputClosed } : s.run }));
    },

    clearOutput() {
      const run = get().run;
      if (run && !isTerminalStatus(run.status as ExecutionStatus) && !run.error) {
        flushLog();
        set({ run: { ...run, log: [] } });
      } else {
        set({ run: null, diagnostics: [] });
      }
    },

    bumpHistory: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),

    abandon() {
      const run = get().run;
      pendingLog = null;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      if (run?.id && isRunning(run)) void api.cancelExecution(run.id).catch(() => {});
      stream?.close();
      stream = null;
      if (run?.mode === "debug") useDebug.getState().onEnded();
      if (run?.mode === "visualize") useVisualize.getState().clear();
      set({ run: null, diagnostics: [] });
    },
  };

  async function start(mode: ExecutionMode, entry?: string) {
      cancelRequested = false;
      if (entry) useWorkspace.getState().setEntryFile(entry);
      await useWorkspace.getState().flush();
      let project = useWorkspace.getState().project;
      if (!project) return;

      // Compiled languages start from a main function; resolve which file holds it.
      if (!anyFileIsRunnable(project.language)) {
        const entries = findEntryPoints(project.language, project.files);
        const entryFiles = [...new Set(entries.map((e) => e.file))];
        if (entries.length > 0 && !entryFiles.includes(project.entryFile)) {
          if (entryFiles.length === 1) {
            useWorkspace.getState().setEntryFile(entryFiles[0]!);
            project = useWorkspace.getState().project!;
          } else if (entryChooser.open) {
            entryChooser.open(mode);
            return;
          }
        }
      }
      if (!project.files.some((f) => f.path === project.entryFile)) {
        set({
          run: {
            projectId: project.id,
            entry: project.entryFile,
            mode,
            interactive: false,
            status: "SYSTEM_ERROR",
            log: [],
            startedAt: Date.now(),
            error: { title: "No entry file", detail: "Right-click a file in the explorer and choose “Set as entry file”." },
          },
        });
        return;
      }

      useSettings.getState().updateLayout({ bottomOpen: true, bottomTab: mode === "debug" ? "debug" : mode === "visualize" ? "visualize" : "run" });
      // With no prepared input, the program reads what the user types while it runs.
      const interactive = !project.stdin;
      set({
        diagnostics: [],
        run: {
          projectId: project.id,
          entry: project.entryFile,
          mode,
          interactive,
          status: "SUBMITTING",
          // The console shows only the program's own output; the session tab already names the file.
          log: [],
          startedAt: Date.now(),
        },
      });

      let id: string;
      let controlToken: string;
      try {
        ({ id, controlToken } = await api.createExecution({
          language: project.language,
          files: snapshotFiles(project),
          entry: project.entryFile,
          stdin: project.stdin || undefined,
          interactive,
          ...(mode === "debug" ? { mode, breakpoints: liveBreakpoints(project) } : mode === "visualize" ? { mode } : {}),
        }));
      } catch (e) {
        // 0: no response at all; 502/504: the reverse proxy could not reach the API.
        if (e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 504)) {
          set({ runner: "offline" });
          return fail(
            "Execution service unreachable",
            process.env.NODE_ENV === "production"
              ? "The server could not be reached. Check your connection and try again."
              : "Start the API and worker (see README → Running locally), then retry.",
          );
        }
        if (e instanceof ApiError && e.status === 429) return fail("Too many runs", "You are being rate limited. Wait a few seconds and retry.");
        return fail("Could not start execution", e instanceof Error ? e.message : String(e), e instanceof ApiError ? e.requestId : undefined);
      }

      // The project was closed while the run was being accepted: it is not wanted any more.
      if (get().run?.projectId !== project.id || get().run?.status !== "SUBMITTING") {
        void api.cancelExecution(id).catch(() => {});
        return;
      }
      if (mode === "visualize") useVisualize.getState().clear();
      set((s) => ({ runner: "online", run: s.run ? { ...s.run, id, status: "QUEUED" } : s.run }));
      // Stop was pressed while the run was being accepted; its CANCELLED result arrives on the stream.
      if (cancelRequested) {
        cancelRequested = false;
        void api.cancelExecution(id).catch(() => {});
      }
      useWorkspace.getState().markRun();
      if (mode === "debug") useDebug.getState().onStarted(id);
      stream?.close();
      stream = streamExecution(id, controlToken, {
        onEvent: (event) => {
          if (get().run?.id !== id) return;
          switch (event.type) {
            case "status":
              flushLog();
              set((s) => ({ run: s.run ? { ...s.run, status: event.status } : s.run }));
              break;
            case "stdout":
            case "stderr":
            case "compile":
            case "stdin":
              queueLog(id, { stream: event.type, text: event.chunk });
              break;
            case "debug":
              useDebug.getState().onEvent(event.event);
              break;
            case "trace":
              useVisualize.getState().setTrace(id, event.trace);
              break;
            case "result":
              void finish(event.result, project);
              break;
          }
        },
        onDebugError: (requestId, message) => useDebug.getState().onCommandError(requestId, message),
        onInputError: (message) => set((s) => ({ run: s.run && s.run.id === id ? { ...s.run, inputError: message } : s.run })),
        onError: async (message) => {
          // The stream dropped; the program keeps running on the server. Wait for its result.
          // Debug sessions need the live connection for their commands, so they cannot be recovered this way.
          const recoverable = get().run?.mode !== "debug";
          {
            const result = recoverable ? await waitForResult(id, () => get().run?.id === id) : null;
            if (result) {
              flushLog();
              set((s) => ({
                run: s.run
                  ? {
                      ...s.run,
                      log: [
                        ...s.run.log.filter((c) => c.stream === "system"),
                        ...(result.compileOutput ? [{ stream: "compile" as const, text: result.compileOutput }] : []),
                        ...(result.stdout ? [{ stream: "stdout" as const, text: result.stdout }] : []),
                        ...(result.stderr ? [{ stream: "stderr" as const, text: result.stderr }] : []),
                      ],
                    }
                  : s.run,
              }));
              return void finish(result, project);
            }
          }
          if (get().run?.id === id) fail("Lost connection to the program", recoverable ? `${message} It did not finish within a minute; run it again.` : message);
        },
      });
  }
});

export function isRunning(run: RunState | null): boolean {
  return !!run && !run.error && (run.status === "SUBMITTING" || !isTerminalStatus(run.status));
}

// Errors describe the code as it was when it ran. Once a file is edited, its marks no longer
// line up with the text (a deleted line would keep its red squiggle), so they are cleared.
useWorkspace.subscribe((s, prev) => {
  // A run, its console, errors and debug session belong to the project they ran for.
  if (s.project?.id !== prev.project?.id) {
    const { run, diagnostics } = useExecution.getState();
    if ((run && run.projectId !== s.project?.id) || diagnostics.length) useExecution.getState().abandon();
    return;
  }
  if (!s.project || !prev.project || s.project.id !== prev.project.id || s.project.files === prev.project.files) return;
  const { diagnostics } = useExecution.getState();
  if (!diagnostics.length) return;
  const before = new Map(prev.project.files.map((f) => [f.path, f.content]));
  const edited = new Set(s.project.files.filter((f) => before.get(f.path) !== f.content).map((f) => f.path));
  if (!edited.size) return;
  const kept = diagnostics.filter((d) => !edited.has(d.file));
  if (kept.length !== diagnostics.length) useExecution.setState({ diagnostics: kept });
});
