"use client";

import { create } from "zustand";
import {
  getLanguage,
  isTerminalStatus,
  parseDiagnostics,
  runTarget,
  splitSqlOutput,
  sqlStateFile,
  SQL_STATE_MARK,
  basename,
  type SqlLogEntry,
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
import { usePreview } from "@/features/preview/store";
import { editorBridge } from "@/features/editor/bridge";
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
  /** What ran, when it was not a whole file: a selection (`main.sql · lines 3-5`) or a table opened from the database panel. */
  title?: string;
  /** SQL run from the database panel, not from a file. */
  query?: boolean;
  /** A SQL run: what each statement did, once the run has ended. */
  statements?: SqlLogEntry[];
  /** A SQL run that could not leave its database behind: why. */
  databaseNote?: string;
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
  /** Someone else's run in a live session, shown here read-only. Their name. */
  watchedBy?: string;
  /** Client-side failure (network, validation). Distinct from program errors. */
  error?: { title: string; detail?: string; requestId?: string };
  startedAt: number;
}

/** SQL run on the project's database without being a file of the project: opening a table from the database panel. */
export interface Query {
  title: string;
  sql: string;
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
   * Runs or debugs the program in the editor: the open file when it is a
   * program of its own, otherwise the project's entry file. `entry` runs a
   * given file instead. What ran is remembered as the entry file. When the
   * program cannot be told (the open file and the entry file have no entry
   * point and several other files do), asks which one to run instead of guessing.
   */
  execute: (options?: { mode?: ExecutionMode; entry?: string; query?: Query }) => Promise<void>;
  /** Sends a line (or raw text) of input to the running program; `eof` closes its stdin. */
  sendInput: (text: string, eof?: boolean) => void;
  cancel: () => Promise<void>;
  clearOutput: () => void;
  bumpHistory: () => void;
  /**
   * Shows someone else's run from a live session (output, errors, result) as
   * it happens. Ignored while this person has a run of their own going.
   */
  watch: (run: { executionId: string; mode: ExecutionMode; entry: string; by: string; interactive?: boolean }) => void;
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

/** Sends typed input to a run watched in a live session. Set by the live session. */
export const watchedInput: { send: ((executionId: string, text: string, eof: boolean) => boolean) | null } = { send: null };

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

/**
 * A program waiting for typed input must never wait unseen: when the bottom
 * panel is closed, or shows a tab with no input box (Tests, Problems, Program
 * Input, or another mode's tab), it switches to the run's own tab, where the
 * input bar is.
 */
function showInputFor(run: { mode: string; interactive?: boolean; watchedBy?: string } | null) {
  if (!run || !run.interactive) return;
  const tab = run.mode === "debug" ? "debug" : run.mode === "visualize" ? "visualize" : "run";
  const { layout, updateLayout } = useSettings.getState();
  if (!layout.bottomOpen || layout.bottomTab !== tab) updateLayout({ bottomOpen: true, bottomTab: tab });
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
    const watched = !!get().run?.watchedBy;
    let sql: Pick<RunState, "statements" | "databaseNote"> = {};
    if (getLanguage(result.language)?.database && get().run?.mode === "run") {
      // After the output comes the database as the run left it: the project keeps it for its next run.
      const { text, report } = splitSqlOutput(result.stdout);
      result = { ...result, stdout: text };
      const ran = result.status === "SUCCESS" || result.status === "RUNTIME_ERROR";
      if (report?.database && useWorkspace.getState().project?.id === project.id) useWorkspace.getState().setDatabase(report.database);
      sql = {
        statements: report?.log,
        databaseNote: report?.database
          ? undefined
          : report?.tooLarge
            ? "The database has grown past what can be kept between runs (about 200 KB), so it is as it was before this run. Delete rows or tables you no longer need."
            : ran
              ? "The database could not be read back after this run, so it is as it was before it."
              : undefined,
      };
    }
    if (get().run?.mode === "debug" && !watched) useDebug.getState().onEnded();
    const files = project.files.map((f) => f.path);
    const diagnostics = [
      ...parseDiagnostics(result.language, result.compileOutput, files),
      ...parseDiagnostics(result.language, result.stderr, files),
    ];
    set((s) => ({
      run: s.run && s.run.id === result.id ? { ...s.run, status: result.status, result, ...sql } : s.run,
      diagnostics,
    }));
    // A temporary project leaves nothing behind, its runs included. Neither does a look at a table.
    if (useSettings.getState().recordHistory && !watched && !project.temporary && !get().run?.query) {
      try {
        await historyRepo.record({
          id: createId(),
          projectId: project.id,
          projectName: project.name,
          language: project.language,
          // The file this run started from (Run Current File may not be the project's entry file).
          entryFile: get().run?.entry || project.entryFile,
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
    if (get().run?.mode === "debug" && !get().run?.watchedBy) useDebug.getState().onEnded();
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
      // A page that runs in the browser is shown in the preview; nothing is sent to a sandbox.
      const project = useWorkspace.getState().project;
      if (project && getLanguage(project.language)?.preview) return void usePreview.getState().run();
      if (starting || isOwnRun(get().run)) return;
      starting = true;
      try {
        await start(mode, options?.entry, options?.query);
      } finally {
        starting = false;
      }
    },

    async cancel() {
      const run = get().run;
      if (run?.watchedBy) {
        // Someone else's run: stop showing it here; it keeps running for them.
        flushLog();
        stream?.close();
        stream = null;
        return void set({ run: null });
      }
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
      // Someone else's run: the input goes through the live session to their program.
      const sent = run.watchedBy ? (watchedInput.send?.(run.id, text, eof) ?? false) : stream?.sendInput(text, eof);
      if (!sent) {
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

    watch({ executionId, mode, entry, by, interactive = false }) {
      const project = useWorkspace.getState().project;
      if (!project || starting || isOwnRun(get().run) || get().run?.id === executionId) return;
      pendingLog = null;
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = null;
      set({ diagnostics: [], run: { id: executionId, projectId: project.id, entry, mode, interactive, status: "QUEUED", log: [], startedAt: Date.now(), watchedBy: by } });
      useSettings.getState().updateLayout({ bottomOpen: true, bottomTab: mode === "visualize" ? "visualize" : "run" });
      if (mode === "visualize") useVisualize.getState().clear();
      follow(executionId, "", project);
    },

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

  async function start(mode: ExecutionMode, entry?: string, query?: Query) {
      cancelRequested = false;
      if (entry) useWorkspace.getState().setEntryFile(entry);
      await useWorkspace.getState().flush();
      let project = useWorkspace.getState().project;
      if (!project) return;
      const database = mode === "run" ? getLanguage(project.language)?.database : undefined;
      if (query && !database) return;

      // What is on screen is what runs; other programs in the project are left alone.
      const target = query ? { entry: project.entryFile } : runTarget(project, entry ?? useWorkspace.getState().activeFile);
      if ("choices" in target && target.choices && entryChooser.open) {
        entryChooser.open(mode);
        return;
      }
      if (target.entry !== project.entryFile) {
        useWorkspace.getState().setEntryFile(target.entry);
        project = useWorkspace.getState().project ?? project;
        // A read-only copy cannot remember the choice; it still runs what was asked.
        if (project.entryFile !== target.entry) project = { ...project, entryFile: target.entry };
      }
      if (!query && !project.files.some((f) => f.path === project.entryFile)) {
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
      const interactive = !project.stdin && !query;

      // What is sent. With a database, as in a database tool: the selected statements run on their own
      // (kept on their lines, so an error still names the right one), and the database goes along.
      let files = snapshotFiles(project);
      let runEntry = project.entryFile;
      let title: string | undefined;
      if (database) {
        const selected = !query && !entry && useWorkspace.getState().activeFile === project.entryFile ? editorBridge.selection() : null;
        if (query) {
          runEntry = "query.sql";
          files = [{ path: runEntry, content: query.sql }];
          title = query.title;
        } else if (selected && selected.text.trim()) {
          files = files.map((f) => (f.path === runEntry ? { path: f.path, content: "\n".repeat(selected.startLine - 1) + selected.text } : f));
          title = `${basename(runEntry)} · ${selected.startLine === selected.endLine ? `line ${selected.startLine}` : `lines ${selected.startLine}-${selected.endLine}`}`;
        }
        files = [...files.filter((f) => f.path !== database.file), { path: database.file, content: sqlStateFile(project.database) }];
      }
      set({
        diagnostics: [],
        run: {
          projectId: project.id,
          entry: project.entryFile,
          ...(title ? { title } : {}),
          ...(query ? { query: true } : {}),
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
          files,
          entry: runEntry,
          stdin: query ? undefined : project.stdin || undefined,
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
      if (!query) useWorkspace.getState().markRun();
      if (mode === "debug") useDebug.getState().onStarted(id);
      follow(id, controlToken, project);
  }

  /** Streams an execution's events into the console: this person's run, or one they watch. */
  function follow(id: string, controlToken: string, project: Project) {
      // A run with a database prints the database after its output; that part is not for the console.
      const reports = !!getLanguage(project.language)?.database;
      let reporting = false;
      stream?.close();
      stream = streamExecution(id, controlToken, {
        onEvent: (event) => {
          if (get().run?.id !== id) return;
          switch (event.type) {
            case "status":
              flushLog();
              set((s) => ({ run: s.run ? { ...s.run, status: event.status } : s.run }));
              if (event.status === "WAITING_FOR_INPUT") showInputFor(get().run);
              break;
            case "stdout": {
              if (reporting) break;
              const at = reports ? event.chunk.indexOf(SQL_STATE_MARK) : -1;
              reporting = at >= 0;
              const text = at >= 0 ? event.chunk.slice(0, at) : event.chunk;
              if (text) queueLog(id, { stream: "stdout", text });
              break;
            }
            case "stderr":
            case "compile":
            case "stdin":
              queueLog(id, { stream: event.type, text: event.chunk });
              break;
            case "debug":
              if (!get().run?.watchedBy) useDebug.getState().onEvent(event.event);
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
                        ...(result.stdout ? [{ stream: "stdout" as const, text: reports ? splitSqlOutput(result.stdout).text : result.stdout }] : []),
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

/** A run this person started (not someone else's run they are watching in a live session). */
export function isOwnRun(run: RunState | null): boolean {
  return isRunning(run) && !run!.watchedBy;
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
