"use client";

import { useState } from "react";
import { CheckSquare, CloudUpload, Play, Plus, SquareTerminal, X } from "lucide-react";
import { outputLines, type InterviewVerdict } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/primitives";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { casesOf, useCandidate, type CaseResult, type RunStatus } from "./candidate";

const RUN_TEXT: Record<RunStatus, { label: string; tone: "good" | "bad" | "plain" }> = {
  accepted: { label: "Accepted", tone: "good" },
  "wrong-answer": { label: "Wrong Answer", tone: "bad" },
  "runtime-error": { label: "Runtime Error", tone: "bad" },
  "time-limit": { label: "Time Limit Exceeded", tone: "bad" },
  "compile-error": { label: "Compile Error", tone: "bad" },
  finished: { label: "Finished", tone: "plain" },
};

export const VERDICT_TEXT: Record<InterviewVerdict["status"], string> = {
  accepted: "Accepted",
  "wrong-answer": "Wrong Answer",
  "runtime-error": "Runtime Error",
  "time-limit": "Time Limit Exceeded",
  "compile-error": "Compile Error",
  error: "Not checked",
};

const toneClass = { good: "text-success", bad: "text-danger", plain: "text-fg" };
const box = "w-full rounded-lg bg-surface-2 px-3 py-2 font-mono text-[13px] leading-relaxed text-fg";
const fieldLabel = "mb-1.5 text-xs font-medium text-fg-subtle";

/** Samples as the candidate sees them (kept by the server), falling back to the project's tests. */
function useCases() {
  const samples = useLive((s) => s.interview?.samples);
  const tests = useWorkspace((s) => s.project?.tests);
  const custom = useCandidate((s) => s.custom);
  return casesOf(samples ?? tests ?? [], custom);
}

function Chip({ active, onClick, children, dot }: { active: boolean; onClick: () => void; children: React.ReactNode; dot?: "good" | "bad" }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors", active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dot === "good" ? "bg-success" : "bg-danger")} />}
      {children}
    </button>
  );
}

function Block({ label, text, tone }: { label: string; text: string; tone?: "bad" }) {
  return (
    <div>
      <div className={fieldLabel}>{label}</div>
      <pre className={cn(box, "max-h-48 overflow-auto whitespace-pre-wrap break-words", tone === "bad" && "text-danger")}>{text === "" ? <span className="text-fg-faint">(nothing)</span> : text.length > 6000 ? `${text.slice(0, 6000)}\n… (${text.length.toLocaleString("en-US")} characters in all)` : text}</pre>
    </div>
  );
}

function Cases({ locked }: { locked: boolean }) {
  const cases = useCases();
  const selected = useCandidate((s) => s.selected);
  const canAdd = useCandidate((s) => s.custom.length < 6);
  const { select, addCase, updateCase, removeCase } = useCandidate.getState();
  const current = cases.find((c) => c.id === selected) ?? cases[0];
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-1">
        {cases.map((c, i) => (
          <span key={c.id} className="group relative">
            <Chip active={c.id === current?.id} onClick={() => select(c.id)}>
              Case {i + 1}
            </Chip>
            {c.custom && !locked && (
              <button
                type="button"
                aria-label={`Remove case ${i + 1}`}
                onClick={() => removeCase(c.id)}
                className="absolute -right-1 -top-1 hidden size-4 items-center justify-center rounded-full bg-fg-subtle text-canvas group-hover:flex [@media(pointer:coarse)]:flex"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {canAdd && !locked && (
          <button type="button" aria-label="Add a case of your own" onClick={addCase} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-hover hover:text-fg">
            <Plus className="size-4" />
          </button>
        )}
      </div>
      {!current ? (
        <p className="text-sm text-fg-subtle">This problem has no example tests. Press + to try an input of your own, or Run to run the code with no input.</p>
      ) : current.custom ? (
        <div>
          <div className={fieldLabel}>Input (your own case)</div>
          <textarea
            aria-label="Case input"
            value={current.input}
            readOnly={locked}
            spellCheck={false}
            rows={Math.min(8, Math.max(3, current.input.split("\n").length))}
            onChange={(e) => updateCase(current.id, e.target.value)}
            placeholder="What the program reads"
            className={cn(box, "resize-y outline-none focus:ring-1 focus:ring-accent")}
          />
          <p className="mt-1.5 text-xs text-fg-subtle">Run shows what your code prints for this input.</p>
        </div>
      ) : (
        <>
          <Block label="Input" text={current.input} />
          <Block label="Expected output" text={current.expected ?? ""} />
        </>
      )}
    </div>
  );
}

function RunResult() {
  const results = useCandidate((s) => s.results);
  const status = useCandidate((s) => s.status);
  const compileError = useCandidate((s) => s.compileError);
  const error = useCandidate((s) => s.error);
  const selected = useCandidate((s) => s.selected);
  if (status === "compile-error") {
    return (
      <div className="space-y-3 p-3">
        <h3 className="text-lg font-semibold text-danger">Compile Error</h3>
        <pre className={cn(box, "max-h-64 overflow-auto whitespace-pre-wrap break-words bg-danger/10 text-danger")}>{compileError}</pre>
      </div>
    );
  }
  if (!results) return <Empty>{error ?? "You must run your code first"}</Empty>;
  const meta = RUN_TEXT[status ?? "finished"];
  const current: CaseResult | undefined = results.find((r) => r.case.id === selected) ?? results[0];
  const time = Math.max(0, ...results.flatMap((r) => (r.run?.executionTime !== undefined ? [r.run.executionTime] : [])));
  const checked = results.filter((r) => !r.case.custom && r.case.expected?.trim());
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className={cn("text-lg font-semibold", toneClass[meta.tone])}>{meta.label}</h3>
        <span className="text-xs text-fg-subtle">
          {checked.length > 0 && `${checked.filter((r) => r.comparison.verdict === "passed").length} / ${checked.length} example tests passed · `}Runtime: {time} ms
        </span>
      </div>
      {error && <p className="text-xs text-warning">{error}</p>}
      <div className="flex flex-wrap items-center gap-1">
        {results.map((r, i) => (
          <Chip key={r.case.id} active={r.case.id === current?.case.id} onClick={() => useCandidate.getState().select(r.case.id)} dot={r.comparison.verdict === "passed" || r.comparison.verdict === "ran" ? "good" : "bad"}>
            Case {i + 1}
          </Chip>
        ))}
      </div>
      {current && (
        <>
          {current.comparison.verdict === "time-limit" && <p className="text-sm text-danger">This case ran out of time.</p>}
          {hasExtraText(current) && (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
              The answer is in your output, with other text around it. Print only the answer: no prompts such as &quot;Enter a number:&quot; and no extra messages.
            </p>
          )}
          <Block label="Input" text={current.case.input} />
          <Block label="Output" text={current.run?.stdout ?? ""} tone={current.comparison.verdict === "failed" ? "bad" : undefined} />
          {!current.case.custom && current.case.expected?.trim() ? <Block label="Expected" text={current.case.expected} /> : null}
          {current.run?.stderr ? <Block label="Errors" text={current.run.stderr} tone="bad" /> : null}
        </>
      )}
    </div>
  );
}

/** The expected output is there, with other text around it: prompts or messages printed along with the answer. */
export function hasExtraText(r: CaseResult): boolean {
  if (r.comparison.verdict !== "failed" || !r.run) return false;
  const want = outputLines(r.case.expected ?? "").join("\n").trim();
  const got = outputLines(r.run.stdout).join("\n").trim();
  return want !== "" && got !== want && got.includes(want);
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center px-4 text-center text-sm text-fg-subtle">{children}</div>;
}

/** What a verdict says in one line under its heading. */
export function verdictDetail(v: InterviewVerdict): string {
  if (v.status === "error") return v.message ?? "The tests could not run.";
  if (v.status === "compile-error") return "The code did not compile, so no test ran.";
  if (!v.total) return v.message ?? "Your code has been recorded.";
  const failed = v.firstFailed ? ` · first failed: ${v.firstFailed.kind === "sample" ? `example ${v.firstFailed.number}` : `hidden test ${v.firstFailed.number}`}` : "";
  return `${v.passed} / ${v.total} tests passed${failed}${v.timeMs !== undefined ? ` · ${v.timeMs} ms` : ""}`;
}

function SubmitResult({ locked }: { locked: boolean }) {
  const judging = useLive((s) => !!s.interview?.judging);
  const verdict = useLive((s) => s.interview?.verdicts?.at(-1));
  const awaiting = useCandidate((s) => s.awaiting !== null);
  const submitError = useCandidate((s) => s.submitError);
  const [confirm, setConfirm] = useState(false);
  if (judging || awaiting) {
    return (
      <Empty>
        <span className="flex items-center gap-2">
          <Spinner /> Checking your code on every test…
        </span>
      </Empty>
    );
  }
  if (submitError) return <Empty>{submitError}</Empty>;
  if (!verdict) return <Empty>Submit checks your code on every test, including hidden ones.</Empty>;
  const good = verdict.status === "accepted";
  return (
    <div className="space-y-3 p-3">
      <div>
        <h3 className={cn("text-lg font-semibold", good ? "text-success" : verdict.status === "error" ? "text-warning" : "text-danger")}>{VERDICT_TEXT[verdict.status]}</h3>
        <p className="mt-0.5 text-[13px] text-fg-muted">{verdictDetail(verdict)}</p>
      </div>
      {verdict.total > 0 && verdict.status !== "compile-error" && verdict.status !== "error" && (
        <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div className={cn("h-full rounded-full", good ? "bg-success" : "bg-danger")} style={{ width: `${(verdict.passed / verdict.total) * 100}%` }} />
        </div>
      )}
      {verdict.compileOutput && <pre className={cn(box, "max-h-56 overflow-auto whitespace-pre-wrap break-words bg-danger/10 text-danger")}>{verdict.compileOutput}</pre>}
      {verdict.firstFailed?.kind === "hidden" && <p className="text-xs text-fg-subtle">Hidden tests are not shown. Think about edge cases: the smallest and largest inputs, empty input, repeated values.</p>}
      {locked ? (
        <p className="text-xs text-fg-subtle">{verdict.final ? "This is the code that was handed in when the interview ended." : "The interview has ended."}</p>
      ) : confirm ? (
        <div className="space-y-2 rounded-lg border border-line-strong p-3 text-sm">
          <p>Finish the interview now? You cannot change your code afterwards.</p>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => useLive.getState().sendInterview({ type: "interview-end" })}>
              Yes, finish
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Keep working
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={good ? "primary" : "secondary"} onClick={() => setConfirm(true)}>
            Finish interview
          </Button>
          <span className="text-xs text-fg-subtle">Or keep working: you can submit again until the time is up.</span>
        </div>
      )}
    </div>
  );
}

/** Run and Submit, as they appear in the title bar and beside the test tabs. */
export function RunSubmit({ className }: { className?: string }) {
  const running = useCandidate((s) => s.phase !== "idle");
  const awaiting = useCandidate((s) => s.awaiting !== null);
  const judging = useLive((s) => !!s.interview?.judging);
  const closed = useLive((s) => !s.interview?.startedAt || !!s.interview.endedAt || s.role === "viewer");
  const busy = running || judging || awaiting;
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <button
        type="button"
        aria-label="Run program"
        title="Run on the example tests (Ctrl+Enter)"
        disabled={busy || closed}
        onClick={() => void useCandidate.getState().run()}
        className="flex h-8 items-center gap-1.5 rounded-lg bg-surface-3 px-3 text-[13px] font-medium text-fg transition-[filter,transform] hover:brightness-110 active:scale-[0.97] disabled:opacity-45"
      >
        {running ? <Spinner className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
        Run
      </button>
      <button
        type="button"
        aria-label="Submit code"
        title="Check on every test, including hidden ones"
        disabled={busy || closed}
        onClick={() => useCandidate.getState().submit()}
        className="flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-b from-[#29a35d] to-[#1f8f4e] px-3 text-[13px] font-medium text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.97] disabled:opacity-45"
      >
        {judging || awaiting ? <Spinner className="size-3.5" /> : <CloudUpload className="size-3.5" />}
        Submit
      </button>
    </div>
  );
}

/**
 * Under the editor in an interview: the cases to run on, and the result of a
 * Run or a submission. `actions`: Run and Submit sit here (on phones they are
 * in the title bar, where they stay in reach while this is closed).
 */
export function CandidateTests({ actions = true }: { actions?: boolean }) {
  const tab = useCandidate((s) => s.tab);
  const view = useCandidate((s) => s.view);
  const running = useCandidate((s) => s.phase !== "idle");
  const locked = useLive((s) => !!s.interview?.endedAt || s.role === "viewer");
  const tabs = [
    { id: "cases" as const, label: "Testcase", icon: <CheckSquare className="size-4 text-success" /> },
    { id: "result" as const, label: "Test Result", icon: <SquareTerminal className="size-4 text-success" /> },
  ];
  return (
    <section aria-label="Tests" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-surface-2/60 px-2">
        <div role="tablist" aria-label="Tests" className="flex items-center gap-0.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => useCandidate.getState().setTab(t.id)}
              className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] transition-colors", tab === t.id ? "font-semibold text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        {actions && <RunSubmit className="ml-auto" />}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tab === "cases" ? (
          <Cases locked={locked} />
        ) : running ? (
          <Empty>
            <span className="flex items-center gap-2">
              <Spinner /> Running your code…
            </span>
          </Empty>
        ) : view === "submit" ? (
          <SubmitResult locked={locked} />
        ) : (
          <RunResult />
        )}
      </div>
    </section>
  );
}
