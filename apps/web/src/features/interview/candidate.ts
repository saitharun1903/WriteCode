"use client";

import { create } from "zustand";
import { judge, parseDiagnostics, TEST_LIMITS, type Comparison, type InterviewTest, type TestRunResult } from "@cw/shared";
import { ApiError } from "@/features/execution/api";
import { useExecution } from "@/features/execution/store";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { chooseEntry } from "@/features/tests/store";
import { useUI } from "@/features/workspace/ui-store";
import { createId } from "@/lib/id";
import { COMPACT_QUERY } from "@/lib/use-media";
import { runTests } from "./store";

/** A test the candidate can run: one of the problem's samples, or an input of their own. */
export interface CandidateCase {
  id: string;
  input: string;
  /** Samples have one; a case of the candidate's own only shows what the code prints. */
  expected?: string;
  custom: boolean;
}

export interface CaseResult {
  case: CandidateCase;
  run?: TestRunResult;
  comparison: Comparison;
}

export type RunStatus = "accepted" | "wrong-answer" | "runtime-error" | "time-limit" | "compile-error" | "finished";

/** How many cases one Run may carry. */
const MAX_CUSTOM = TEST_LIMITS.maxTests - 6;
/** No word from the server about a submission after this long: say so. */
const SUBMIT_TIMEOUT_MS = 8000;

interface CandidateState {
  tab: "cases" | "result";
  /** Which the result tab shows: the latest Run, or the latest submission. */
  view: "run" | "submit";
  custom: { id: string; input: string }[];
  selected: string | null;
  phase: "idle" | "running";
  results: CaseResult[] | null;
  status?: RunStatus;
  compileError?: string;
  error?: string;
  /** Verdicts there were when Submit was pressed; the next one is this submission's. */
  awaiting: number | null;
  submitError?: string;

  setTab: (tab: CandidateState["tab"]) => void;
  select: (id: string) => void;
  addCase: () => void;
  updateCase: (id: string, input: string) => void;
  removeCase: (id: string) => void;
  /** Runs the code on the sample tests and the candidate's own cases. */
  run: () => Promise<void>;
  /** Hands the code to the server, which checks it on every test, hidden ones included. */
  submit: () => void;
  reset: () => void;
}

/** The problem's sample tests: kept by the server, so they are the same ones Submit checks. */
export function samplesOf(): InterviewTest[] {
  const live = useLive.getState().interview;
  return live?.samples ?? useWorkspace.getState().project?.tests ?? [];
}

export function casesOf(samples: InterviewTest[], custom: { id: string; input: string }[]): CandidateCase[] {
  return [...samples.map((t) => ({ id: t.id, input: t.input, expected: t.expected, custom: false })), ...custom.map((c) => ({ ...c, custom: true }))];
}

function overall(results: CaseResult[]): RunStatus {
  const verdicts = results.map((r) => r.comparison.verdict);
  if (verdicts.includes("crashed") || verdicts.includes("error")) return "runtime-error";
  if (verdicts.includes("time-limit")) return "time-limit";
  if (verdicts.includes("failed")) return "wrong-answer";
  return verdicts.includes("passed") ? "accepted" : "finished";
}

/** On a phone the tests are a sheet: open it, so the result of a run or a submission is seen. */
function showTests() {
  if (window.matchMedia(COMPACT_QUERY).matches) useUI.getState().setDrawer("bottom");
}

let generation = 0;
let submitTimer: ReturnType<typeof setTimeout> | null = null;

export const useCandidate = create<CandidateState>((set, get) => ({
  tab: "cases",
  view: "run",
  custom: [],
  selected: null,
  phase: "idle",
  results: null,
  awaiting: null,

  setTab: (tab) => set({ tab }),
  select: (id) => set({ selected: id }),

  addCase() {
    if (get().custom.length >= MAX_CUSTOM) return;
    // Starts as a copy of the case being looked at, like changing an example by hand.
    const from = casesOf(samplesOf(), get().custom).find((c) => c.id === get().selected);
    const created = { id: `own-${createId()}`, input: from?.input ?? "" };
    set({ custom: [...get().custom, created], selected: created.id, tab: "cases" });
  },

  updateCase: (id, input) => set({ custom: get().custom.map((c) => (c.id === id ? { ...c, input } : c)) }),

  removeCase(id) {
    const custom = get().custom.filter((c) => c.id !== id);
    set({ custom, selected: get().selected === id ? (casesOf(samplesOf(), custom).at(-1)?.id ?? null) : get().selected });
  },

  async run() {
    if (get().phase !== "idle") return;
    const project = useWorkspace.getState().project;
    const live = useLive.getState();
    if (!project || live.interview?.endedAt || live.role === "viewer") return;
    // With nothing to run on, the code still runs once, with no input.
    if (!samplesOf().length && !get().custom.length) get().addCase();
    const cases = casesOf(samplesOf(), get().custom).slice(0, TEST_LIMITS.maxTests);
    const mine = ++generation;
    set({ phase: "running", tab: "result", view: "run", error: undefined, compileError: undefined });
    showTests();
    try {
      const r = await runTests(
        { language: project.language, files: project.files, entry: chooseEntry(project) },
        cases.map((c) => c.input),
        (id) => useLive.getState().announceTests(id, cases.map((c) => c.id)),
      );
      if (mine !== generation) return;
      if (r.status === "COMPILATION_ERROR") {
        // Compiler errors also show in the editor, on the lines they are about.
        useExecution.setState({ diagnostics: parseDiagnostics(r.language, r.compileOutput, project.files.map((f) => f.path)) });
        return set({ phase: "idle", results: null, status: "compile-error", compileError: (r.compileOutput || r.message || "The program did not compile.").trim() });
      }
      useExecution.setState({ diagnostics: [] });
      const results = cases.map((c, i): CaseResult => {
        const run = r.tests?.find((t) => t.index === i);
        return { case: c, run, comparison: run ? judge(run.status, c.expected ?? "", run.stdout) : { verdict: r.status === "TIME_LIMIT" ? "time-limit" : "error" } };
      });
      const picked = results.find((x) => x.comparison.verdict !== "passed" && x.comparison.verdict !== "ran") ?? results.find((x) => x.case.id === get().selected) ?? results[0];
      set({ phase: "idle", results, status: overall(results), selected: picked?.case.id ?? get().selected, error: r.status !== "SUCCESS" && r.message ? r.message : undefined });
    } catch (e) {
      if (mine !== generation) return;
      const error =
        e instanceof ApiError && e.status === 429
          ? "Too many runs right now. Wait a few seconds and run again."
          : e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 504)
            ? "The server could not be reached. Check your connection and run again."
            : e instanceof Error
              ? e.message
              : String(e);
      set({ phase: "idle", results: null, status: undefined, error });
    }
  },

  submit() {
    const live = useLive.getState();
    const iv = live.interview;
    if (!iv?.startedAt || iv.endedAt || iv.judging || get().awaiting !== null || live.role === "viewer") return;
    const before = iv.verdicts?.length ?? 0;
    if (!live.sendInterview({ type: "interview-submit" })) {
      return set({ tab: "result", view: "submit", submitError: "You are not connected. Your code is safe here; submit again when the connection is back." });
    }
    set({ tab: "result", view: "submit", awaiting: before, submitError: undefined });
    showTests();
    if (submitTimer) clearTimeout(submitTimer);
    submitTimer = setTimeout(() => {
      const now = useLive.getState().interview;
      if (get().awaiting === null || now?.judging || (now?.verdicts?.length ?? 0) > before) return;
      set({ awaiting: null, submitError: "The submission did not get through. Submit again." });
    }, SUBMIT_TIMEOUT_MS);
  },

  reset() {
    generation++;
    if (submitTimer) clearTimeout(submitTimer);
    set({ tab: "cases", view: "run", custom: [], selected: null, phase: "idle", results: null, status: undefined, compileError: undefined, error: undefined, awaiting: null, submitError: undefined });
  },
}));

if (typeof window !== "undefined") {
  useLive.subscribe((s, prev) => {
    // The verdict of the submission being waited for has arrived.
    const awaiting = useCandidate.getState().awaiting;
    if (awaiting !== null && (s.interview?.verdicts?.length ?? 0) > awaiting) useCandidate.setState({ awaiting: null });
    // What was handed in at the end is checked too: show it.
    if (s.interview?.verdicts?.at(-1)?.final && !prev.interview?.verdicts?.at(-1)?.final) useCandidate.setState({ tab: "result", view: "submit" });
    if (prev.interview && !s.interview) useCandidate.getState().reset();
  });
}
