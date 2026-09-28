"use client";

import { create } from "zustand";
import { anyFileIsRunnable, findEntryPoints, parseDiagnostics, TEST_LIMITS, type Project, type TestCase, type TestRunResult } from "@cw/shared";
import { ApiError, api, streamExecution, type ExecutionStream } from "@/features/execution/api";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { createId } from "@/lib/id";

export interface TestOutcome {
  state: "queued" | "running" | "done";
  result?: TestRunResult;
  /** The input the test ran with; when it has changed since, the result is out of date. */
  input: string;
}

type Phase = "idle" | "starting" | "compiling" | "running";

interface TestsState {
  selected: string | null;
  phase: Phase;
  /** Results of the latest run, by test id. */
  outcomes: Record<string, TestOutcome>;
  /** The program did not compile, so no test ran. */
  compileError?: string;
  /** The run could not start or was cut short. */
  error?: string;

  select: (id: string | null) => void;
  add: (test?: Partial<Omit<TestCase, "id">>) => string | null;
  update: (id: string, patch: Partial<Omit<TestCase, "id">>) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  /** Runs every test, or just `ids`. */
  run: (ids?: string[]) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

let stream: ExecutionStream | null = null;
let executionId: string | null = null;

const tests = (): TestCase[] => useWorkspace.getState().project?.tests ?? [];

/** The file with the main function when the entry file has none (same rule as Run). */
function entryOf(project: Project): string {
  if (anyFileIsRunnable(project.language)) return project.entryFile;
  const files = [...new Set(findEntryPoints(project.language, project.files).map((e) => e.file))];
  return files.length && !files.includes(project.entryFile) ? files[0]! : project.entryFile;
}

export const useTests = create<TestsState>((set, get) => {
  const end = (patch: Partial<TestsState> = {}) => {
    stream?.close();
    stream = null;
    executionId = null;
    // Tests that never started go back to "not run".
    const outcomes = Object.fromEntries(Object.entries(get().outcomes).filter(([, o]) => o.state === "done"));
    set({ phase: "idle", outcomes, ...patch });
  };

  return {
    selected: null,
    phase: "idle",
    outcomes: {},

    select: (id) => set({ selected: id }),

    add(test) {
      const list = tests();
      if (list.length >= TEST_LIMITS.maxTests) return null;
      const created: TestCase = { id: createId(), input: test?.input ?? "", expected: test?.expected ?? "" };
      useWorkspace.getState().setTests([...list, created]);
      set({ selected: created.id });
      return created.id;
    },

    update(id, patch) {
      useWorkspace.getState().setTests(tests().map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },

    remove(id) {
      const list = tests();
      const at = list.findIndex((t) => t.id === id);
      const next = list.filter((t) => t.id !== id);
      useWorkspace.getState().setTests(next);
      const outcomes = { ...get().outcomes };
      delete outcomes[id];
      set({ outcomes, selected: get().selected === id ? (next[Math.min(at, next.length - 1)]?.id ?? null) : get().selected });
    },

    duplicate(id) {
      const list = tests();
      const at = list.findIndex((t) => t.id === id);
      if (at < 0 || list.length >= TEST_LIMITS.maxTests) return;
      const copy = { ...list[at]!, id: createId() };
      useWorkspace.getState().setTests([...list.slice(0, at + 1), copy, ...list.slice(at + 1)]);
      set({ selected: copy.id });
    },

    async run(ids) {
      if (get().phase !== "idle") return;
      await useWorkspace.getState().flush();
      const project = useWorkspace.getState().project;
      if (!project) return;
      const chosen = (project.tests ?? []).filter((t) => !ids || ids.includes(t.id));
      if (!chosen.length) return;

      const outcomes = { ...get().outcomes };
      for (const [i, t] of chosen.entries()) outcomes[t.id] = { state: i === 0 ? "running" : "queued", input: t.input };
      set({ phase: "starting", outcomes, compileError: undefined, error: undefined });

      let created: { id: string; controlToken: string };
      try {
        created = await api.createExecution({
          language: project.language,
          files: project.files.map((f) => ({ path: f.path, content: f.content })),
          entry: entryOf(project),
          mode: "test",
          tests: chosen.map((t) => t.input),
        });
      } catch (e) {
        const message =
          e instanceof ApiError && e.status === 429
            ? "Too many runs right now. Wait a few seconds and try again."
            : e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 504)
              ? "The server could not be reached. Check your connection and try again."
              : e instanceof Error
                ? e.message
                : String(e);
        return end({ error: message });
      }
      executionId = created.id;
      useWorkspace.getState().markRun();
      let compileOutput = "";

      stream = streamExecution(created.id, created.controlToken, {
        onEvent: (event) => {
          if (executionId !== created.id) return;
          switch (event.type) {
            case "status":
              if (event.status === "COMPILING") set({ phase: "compiling" });
              else if (event.status === "RUNNING") set({ phase: "running" });
              break;
            case "compile":
              compileOutput += event.chunk;
              break;
            case "test": {
              const test = chosen[event.test.index];
              const next = chosen[event.test.index + 1];
              if (!test) break;
              set((s) => ({
                outcomes: {
                  ...s.outcomes,
                  [test.id]: { ...s.outcomes[test.id]!, state: "done", result: event.test },
                  ...(next ? { [next.id]: { ...s.outcomes[next.id]!, state: "running" } } : {}),
                },
              }));
              break;
            }
            case "result": {
              const r = event.result;
              const files = project.files.map((f) => f.path);
              const diagnostics = parseDiagnostics(r.language, r.compileOutput, files);
              // Compiler errors also show in the editor and the Problems tool window.
              if (r.status === "COMPILATION_ERROR") useExecution.setState({ diagnostics });
              end({
                ...(r.status === "COMPILATION_ERROR" ? { compileError: (r.compileOutput || compileOutput).trim() || r.message || "The program did not compile." } : {}),
                ...(r.status !== "SUCCESS" && r.status !== "COMPILATION_ERROR" && r.status !== "CANCELLED" ? { error: r.message ?? "The tests could not finish." } : {}),
                ...(r.status === "SUCCESS" && r.message ? { error: r.message } : {}),
              });
              break;
            }
          }
        },
        onError: (message) => end({ error: message }),
      });
    },

    async cancel() {
      if (!executionId) return;
      try {
        await api.cancelExecution(executionId);
      } catch {
        end();
      }
    },

    reset: () => {
      stream?.close();
      stream = null;
      executionId = null;
      set({ selected: null, phase: "idle", outcomes: {}, compileError: undefined, error: undefined });
    },
  };
});

// Results belong to the project they ran for.
useWorkspace.subscribe((s, prev) => {
  if (s.project?.id !== prev.project?.id) useTests.getState().reset();
});

/** The last finished run of this project as a test: its input (prepared or typed) and what it printed. */
export function useLastRunAsTest(): { input: string; expected: string } | null {
  const run = useExecution((s) => s.run);
  const projectId = useWorkspace((s) => s.project?.id);
  const stdin = useWorkspace((s) => s.project?.stdin ?? "");
  if (!run || run.projectId !== projectId || run.mode !== "run" || isRunning(run) || run.result?.status !== "SUCCESS") return null;
  const typed = run.log.filter((c) => c.stream === "stdin").map((c) => c.text).join("");
  return { input: run.interactive ? typed : stdin, expected: run.result.stdout };
}
