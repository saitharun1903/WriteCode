"use client";

import type { ExecutionStatus } from "@cw/shared";
import { useExecution } from "@/features/execution/store";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { judge } from "@/features/tests/compare";
import { useTests } from "@/features/tests/store";
import { codeKeyOf, useInterviewTools } from "./store";

const OUTCOME: Partial<Record<ExecutionStatus, string>> = {
  SUCCESS: "succeeded",
  COMPILATION_ERROR: "did not compile",
  RUNTIME_ERROR: "crashed",
  TIME_LIMIT: "ran out of time",
  MEMORY_LIMIT: "ran out of memory",
  OUTPUT_LIMIT: "printed too much",
  CANCELLED: "was stopped",
};

const interviewing = () => {
  const live = useLive.getState();
  return !!live.interview && live.role === "owner";
};

/** Runs the hidden tests on the candidate's current code, unless they already ran on it. */
function autoRunHidden() {
  const project = useWorkspace.getState().project;
  const tests = useLive.getState().interviewPrivate?.hiddenTests ?? [];
  const tools = useInterviewTools.getState();
  if (!project || !tests.length || tools.hidden.running || tools.hidden.codeKey === codeKeyOf(project)) return;
  void tools.runHidden(project, tests);
}

if (typeof window !== "undefined") {
  const reported = new Set<string>();

  // The candidate's runs (watched here): log how they ended; after a success, check the hidden tests.
  useExecution.subscribe((s) => {
    const run = s.run;
    if (!interviewing() || !run?.watchedBy || !run.id || !run.result || reported.has(run.id)) return;
    reported.add(run.id);
    const r = run.result;
    const took = r.executionTime !== undefined ? ` in ${r.executionTime} ms` : "";
    useLive.getState().sendInterview({ type: "interview-event", event: { kind: "run-result", detail: `${run.watchedBy}'s run ${OUTCOME[r.status] ?? r.status.toLowerCase()}${took}` } });
    if (r.status === "SUCCESS") autoRunHidden();
  });

  // The candidate's sample-test runs: log the score.
  useTests.subscribe((s, prev) => {
    if (!interviewing() || !prev.watchedBy || prev.phase === "idle" || s.phase !== "idle" || !prev.runId) return;
    const tests = useWorkspace.getState().project?.tests ?? [];
    const ids = prev.runTestIds;
    // The candidate's own cases have no expected output; only the examples are scored.
    const samples = ids.filter((id) => tests.some((t) => t.id === id));
    const passed = samples.filter((id) => {
      const o = s.outcomes[id];
      const t = tests.find((x) => x.id === id);
      return o?.result && t && judge(o.result.status, t.expected, o.result.stdout).verdict === "passed";
    }).length;
    const detail = s.compileError ? `${prev.watchedBy}'s code did not compile` : samples.length ? `${prev.watchedBy}'s run: ${passed} / ${samples.length} example tests passed` : `${prev.watchedBy}'s run finished`;
    useLive.getState().sendInterview({ type: "interview-event", event: { kind: "run-result", detail } });
    if (!s.compileError) autoRunHidden();
  });

  useLive.subscribe((s, prev) => {
    // Results belong to one interview.
    if (prev.interview && !s.interview) return useInterviewTools.getState().reset();
    // A submission was checked on the server: its hidden tests are the results to show.
    const sub = s.interviewPrivate?.submission;
    if (!sub || s.role !== "owner" || sub.at === prev.interviewPrivate?.submission?.at) return;
    const project = useWorkspace.getState().project;
    const codeKey = project ? codeKeyOf(project) : undefined;
    if (sub.verdict.status === "compile-error") {
      return useInterviewTools.setState({ hidden: { running: false, results: null, compileError: sub.verdict.compileOutput ?? "The program did not compile.", codeKey, ranAt: sub.at } });
    }
    if (sub.verdict.status === "error") return;
    const results = (s.interviewPrivate?.hiddenTests ?? []).flatMap((test, index) => {
      const r = sub.tests.find((t) => t.id === test.id && t.kind === "hidden");
      return r ? [{ test, comparison: { verdict: r.verdict }, run: { index, status: r.status as ExecutionStatus, stdout: r.stdout, stderr: r.stderr, executionTime: r.executionTime } }] : [];
    });
    if (results.length) useInterviewTools.setState({ hidden: { running: false, results, codeKey, ranAt: sub.at } });
  });
}
