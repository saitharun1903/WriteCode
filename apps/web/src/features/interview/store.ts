"use client";

import { create } from "zustand";
import type { ComplexityEstimate, ExecutionResult, InterviewTest, Project, TestRunResult } from "@cw/shared";
import { API_URL, api, streamExecution, waitForResult } from "@/features/execution/api";
import { judge, type Comparison } from "@/features/tests/compare";
import { entryOf } from "@/features/tests/store";

export interface HiddenResult {
  test: InterviewTest;
  comparison: Comparison;
  run?: TestRunResult;
}

interface InterviewToolsState {
  hidden: {
    running: boolean;
    results: HiddenResult[] | null;
    compileError?: string;
    error?: string;
    /** The code the results are for, so they can be marked out of date. */
    codeKey?: string;
    ranAt?: number;
  };
  complexity: { loading: boolean; estimate?: ComplexityEstimate; error?: string; codeKey?: string };
  runHidden: (project: Project, tests: InterviewTest[]) => Promise<void>;
  analyze: (project: Project) => Promise<void>;
  reset: () => void;
}

/** Identifies a version of the code (files and entry), to tell when results are stale. */
export const codeKeyOf = (p: Project) => JSON.stringify([p.entryFile, p.files.map((f) => [f.path, f.content])]);

/** Runs a test execution of `program` and resolves with its final result. */
export function runTests(
  program: { language: string; files: { path: string; content: string }[]; entry: string },
  inputs: string[],
  /** Called with the execution's id once the server has accepted it. */
  onStart?: (executionId: string) => void,
): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    api
      .createExecution({ language: program.language, files: program.files.map((f) => ({ path: f.path, content: f.content })), entry: program.entry, mode: "test", tests: inputs })
      .then(({ id, controlToken }) => {
        onStart?.(id);
        let done = false;
        const stream = streamExecution(id, controlToken, {
          onEvent: (e) => {
            if (e.type !== "result" || done) return;
            done = true;
            stream.close();
            resolve(e.result);
          },
          onError: () => {
            if (done) return;
            void waitForResult(id, () => !done).then((r) => (r ? resolve(r) : reject(new Error("Lost the connection before the tests finished."))));
          },
        });
      })
      .catch(reject);
  });
}

export const useInterviewTools = create<InterviewToolsState>((set, get) => ({
  hidden: { running: false, results: null },
  complexity: { loading: false },

  async runHidden(project, tests) {
    if (get().hidden.running || !tests.length) return;
    const codeKey = codeKeyOf(project);
    set({ hidden: { ...get().hidden, running: true, error: undefined, compileError: undefined } });
    try {
      const r = await runTests({ language: project.language, files: project.files, entry: entryOf(project) }, tests.map((t) => t.input));
      if (r.status === "COMPILATION_ERROR") {
        set({ hidden: { running: false, results: null, compileError: (r.compileOutput || r.message || "The program did not compile.").trim(), codeKey, ranAt: Date.now() } });
        return;
      }
      const results = tests.map((test, i) => {
        const run = r.tests?.find((t) => t.index === i);
        return { test, run, comparison: run ? judge(run.status, test.expected, run.stdout) : ({ verdict: "error" } as Comparison) };
      });
      set({ hidden: { running: false, results, codeKey, ranAt: Date.now(), error: r.status !== "SUCCESS" && r.message ? r.message : undefined } });
    } catch (e) {
      set({ hidden: { ...get().hidden, running: false, error: e instanceof Error ? e.message : String(e) } });
    }
  },

  async analyze(project) {
    if (get().complexity.loading) return;
    const codeKey = codeKeyOf(project);
    set({ complexity: { ...get().complexity, loading: true, error: undefined } });
    try {
      const res = await fetch(`${API_URL}/api/v1/assistant/complexity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: project.language, files: project.files.map((f) => ({ path: f.path, content: f.content })) }),
      });
      const body = (await res.json().catch(() => ({}))) as ComplexityEstimate & { message?: string };
      if (!res.ok) throw new Error(body.message ?? `Request failed (${res.status})`);
      set({ complexity: { loading: false, estimate: body, codeKey } });
    } catch (e) {
      set({ complexity: { ...get().complexity, loading: false, error: e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not reach the server." } });
    }
  },

  reset: () => set({ hidden: { running: false, results: null }, complexity: { loading: false } }),
}));

export interface Growth {
  points: { size: number; ms: number }[];
  /** Fitted exponent k in time ≈ c·size^k, when the data allows a meaningful fit. */
  exponent?: number;
  label?: string;
}

/**
 * Measured growth from the hidden tests: how running time grows with input
 * size. Only fitted when there are at least three tests whose input sizes span
 * 8× or more and whose times rise clearly above start-up noise; a rough guide,
 * not a proof.
 */
export function measuredGrowth(results: HiddenResult[]): Growth {
  const points = results
    .filter((r) => r.run?.status === "SUCCESS" && r.run.executionTime !== undefined)
    .map((r) => ({ size: new TextEncoder().encode(r.test.input).length, ms: r.run!.executionTime! }))
    .sort((a, b) => a.size - b.size);
  const sizes = points.map((p) => p.size);
  const times = points.map((p) => p.ms);
  if (points.length < 3 || sizes[0]! <= 0 || sizes.at(-1)! / sizes[0]! < 8 || Math.max(...times) - Math.min(...times) < 20) return { points };
  // time = startup + c * size^k: the start-up (JVM, interpreter) is the same for every test.
  // For each k the best startup and c follow by least squares; keep the k that fits best.
  let best = { k: 1, err: Infinity };
  for (let k = 0.1; k <= 3.5; k += 0.05) {
    const xs = sizes.map((n) => (n / sizes.at(-1)!) ** k);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = times.reduce((a, b) => a + b, 0) / times.length;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (sxx === 0) continue;
    const c = xs.reduce((a, x, i) => a + (x - mx) * (times[i]! - my), 0) / sxx;
    const startup = my - c * mx;
    if (c <= 0 || startup < -5) continue;
    const err = xs.reduce((a, x, i) => a + (startup + c * x - times[i]!) ** 2, 0);
    if (err < best.err - 1e-9) best = { k, err };
  }
  if (!Number.isFinite(best.err)) return { points };
  const k = best.k;
  const label = k < 0.4 ? "O(1) or O(log n)" : k < 1.12 ? "O(n)" : k < 1.5 ? "O(n log n)" : k < 2.5 ? "O(n²)" : k < 3.25 ? "O(n³)" : "worse than O(n³)";
  return { points, exponent: Math.round(k * 100) / 100, label };
}
