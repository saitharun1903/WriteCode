"use client";

import { create } from "zustand";
import {
  isTerminalStatus,
  parseDiagnostics,
  requireLanguage,
  type Diagnostic,
  type ExecutionResult,
  type ExecutionStatus,
  type Project,
} from "@cw/shared";
import { historyRepo } from "@/features/projects/db";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { createId } from "@/lib/id";
import { ApiError, api, streamExecution } from "./api";

export type RunnerStatus = "unknown" | "online" | "offline" | "unavailable";
export type LogStream = "stdout" | "stderr" | "compile" | "system";

export interface LogChunk {
  stream: LogStream;
  text: string;
}

export interface RunState {
  id?: string;
  projectId: string;
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
  execute: () => Promise<void>;
  cancel: () => Promise<void>;
  clearOutput: () => void;
  bumpHistory: () => void;
}

const MAX_LOG_CHARS = 1_200_000;
let unsubscribe: (() => void) | null = null;

function appendLog(log: LogChunk[], chunk: LogChunk): LogChunk[] {
  const last = log[log.length - 1];
  const total = log.reduce((n, c) => n + c.text.length, 0);
  if (total > MAX_LOG_CHARS) return log;
  if (last && last.stream === chunk.stream) return [...log.slice(0, -1), { stream: chunk.stream, text: last.text + chunk.text }];
  return [...log, chunk];
}

function snapshotFiles(project: Project) {
  return project.files.map((f) => ({ path: f.path, content: f.content }));
}

export const useExecution = create<ExecutionState>((set, get) => {
  const finish = async (result: ExecutionResult, project: Project) => {
    unsubscribe?.();
    unsubscribe = null;
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
    unsubscribe?.();
    unsubscribe = null;
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

    async execute() {
      const current = get().run;
      if (current && !isTerminalStatus(current.status as ExecutionStatus) && !current.error) return;

      await useWorkspace.getState().flush();
      const project = useWorkspace.getState().project;
      if (!project) return;
      if (!project.files.some((f) => f.path === project.entryFile)) {
        set({
          run: {
            projectId: project.id,
            status: "SYSTEM_ERROR",
            log: [],
            startedAt: Date.now(),
            error: { title: "No entry file", detail: "Right-click a file in the explorer and choose “Set as entry file”." },
          },
        });
        return;
      }

      const lang = requireLanguage(project.language);
      set({
        diagnostics: [],
        run: {
          projectId: project.id,
          status: "SUBMITTING",
          log: [{ stream: "system", text: `Running ${project.entryFile} · ${lang.name} ${lang.version}\n` }],
          startedAt: Date.now(),
        },
      });

      let id: string;
      try {
        ({ id } = await api.createExecution({
          language: project.language,
          files: snapshotFiles(project),
          entry: project.entryFile,
          stdin: project.stdin || undefined,
        }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          set({ runner: "offline" });
          return fail("Execution service unreachable", "Start the API and worker (see README → Running locally), then retry.");
        }
        if (e instanceof ApiError && e.status === 429) return fail("Too many runs", "You are being rate limited. Wait a few seconds and retry.");
        return fail("Could not start execution", e instanceof Error ? e.message : String(e), e instanceof ApiError ? e.requestId : undefined);
      }

      set((s) => ({ runner: "online", run: s.run ? { ...s.run, id, status: "QUEUED" } : s.run }));
      unsubscribe = streamExecution(id, {
        onEvent: (event) => {
          if (get().run?.id !== id) return;
          switch (event.type) {
            case "status":
              set((s) => ({ run: s.run ? { ...s.run, status: event.status } : s.run }));
              break;
            case "stdout":
            case "stderr":
            case "compile":
              set((s) => ({ run: s.run ? { ...s.run, log: appendLog(s.run.log, { stream: event.type, text: event.chunk }) } : s.run }));
              break;
            case "result":
              void finish(event.result, project);
              break;
          }
        },
        onError: async (message) => {
          // The stream dropped; the execution may still have finished. Ask once before reporting failure.
          try {
            const result = await api.getExecution(id);
            if (isTerminalStatus(result.status)) {
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
          } catch {}
          fail("Execution stream interrupted", message);
        },
      });
    },

    async cancel() {
      const id = get().run?.id;
      if (!id) return;
      try {
        await api.cancelExecution(id);
      } catch {
        // The result event (CANCELLED or otherwise) is authoritative; nothing to do here.
      }
    },

    clearOutput() {
      const run = get().run;
      if (run && !isTerminalStatus(run.status as ExecutionStatus) && !run.error) {
        set({ run: { ...run, log: [] } });
      } else {
        set({ run: null, diagnostics: [] });
      }
    },

    bumpHistory: () => set((s) => ({ historyVersion: s.historyVersion + 1 })),
  };
});

export function isRunning(run: RunState | null): boolean {
  return !!run && !run.error && (run.status === "SUBMITTING" || !isTerminalStatus(run.status));
}
