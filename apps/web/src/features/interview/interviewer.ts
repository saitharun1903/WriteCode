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
    const passed = ids.filter((id) => {
      const o = s.outcomes[id];
      const t = tests.find((x) => x.id === id);
      return o?.result && t && judge(o.result.status, t.expected, o.result.stdout).verdict === "passed";
    }).length;
    const detail = s.compileError ? `${prev.watchedBy}'s sample tests did not compile` : `${prev.watchedBy}'s sample tests: ${passed} / ${ids.length} passed`;
    useLive.getState().sendInterview({ type: "interview-event", event: { kind: "run-result", detail } });
  });

  // Results belong to one interview.
  useLive.subscribe((s, prev) => {
    if (prev.interview && !s.interview) useInterviewTools.getState().reset();
  });
}
