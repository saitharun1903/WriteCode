"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Eye, EyeOff, PenLine, Plus, Trash2 } from "lucide-react";
import { INTERVIEW_LIMITS, LANGUAGES, TEST_LIMITS, type InterviewSetup, type InterviewTest, type ProblemDifficulty } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { createId } from "@/lib/id";
import { cn } from "@/lib/cn";
import { prepareProblem, type Step } from "./generate";
import { useInterviewUI } from "./ui";

const DURATIONS = [15, 30, 45, 60, 90, 120];
const field = "w-full rounded-lg border border-line-strong/70 bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none placeholder:text-fg-faint focus:border-accent";
const select = "h-8 w-full rounded-lg border border-line-strong/70 bg-surface-2 px-2.5 text-[13px] text-fg outline-none focus:border-accent";
const label = "text-xs font-medium text-fg-muted";

const STEPS: { id: Step; text: string }[] = [
  { id: "writing", text: "Writing the problem and its edge cases" },
  { id: "checking", text: "Running two solutions on every input and comparing their answers" },
  { id: "large", text: "Timing the large inputs" },
];

const kb = (s: string) => {
  const n = new TextEncoder().encode(s).length;
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;
};

function TestList({ label: name, hint, icon, tests, onChange, max }: { label: string; hint: string; icon: React.ReactNode; tests: InterviewTest[]; onChange: (t: InterviewTest[]) => void; max: number }) {
  return (
    <fieldset className="space-y-2">
      <legend className="flex w-full items-center gap-1.5 text-[13px] font-semibold text-fg">
        {icon}
        {name}
        {tests.length > 0 && <span className="ml-0.5 rounded-full bg-surface-3 px-1.5 text-[11px] font-medium text-fg-subtle">{tests.length}</span>}
      </legend>
      <p className="text-xs text-fg-subtle">{hint}</p>
      {tests.map((t, i) => {
        const big = t.input.length > 2000;
        return (
          <div key={t.id} className="rounded-lg border border-line-strong/50 bg-surface/50 p-2">
            {t.note && <p className="mb-1.5 px-0.5 text-xs text-fg-muted">{t.note}</p>}
            <div className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
              <textarea
                aria-label={`${name} ${i + 1} input`}
                value={t.input}
                rows={big ? 2 : Math.min(5, Math.max(2, t.input.split("\n").length - 1))}
                placeholder="Input"
                spellCheck={false}
                onChange={(e) => onChange(tests.map((x) => (x.id === t.id ? { ...x, input: e.target.value } : x)))}
                className={cn(field, "resize-y font-mono text-[12px] leading-snug")}
              />
              <textarea
                aria-label={`${name} ${i + 1} expected output`}
                value={t.expected}
                rows={big ? 2 : Math.min(5, Math.max(2, t.expected.split("\n").length - 1))}
                placeholder="Expected output"
                spellCheck={false}
                onChange={(e) => onChange(tests.map((x) => (x.id === t.id ? { ...x, expected: e.target.value } : x)))}
                className={cn(field, "resize-y font-mono text-[12px] leading-snug")}
              />
              <button type="button" aria-label={`Remove ${name} ${i + 1}`} onClick={() => onChange(tests.filter((x) => x.id !== t.id))} className="mt-1.5 rounded p-1 text-fg-subtle hover:bg-danger/15 hover:text-danger">
                <Trash2 className="size-4" />
              </button>
            </div>
            {big && <p className="mt-1 px-0.5 text-[11px] text-fg-subtle">Input {kb(t.input)}</p>}
          </div>
        );
      })}
      {tests.length < max && (
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...tests, { id: createId(), input: "", expected: "" }])}>
          Add {name.toLowerCase().replace(/s$/, "")}
        </Button>
      )}
    </fieldset>
  );
}

/** A topic in, a complete problem out: statement, samples and hidden tests with checked answers. */
function Writer({ disabled, onDone }: { disabled: boolean; onDone: (p: Awaited<ReturnType<typeof prepareProblem>>) => void }) {
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<ProblemDifficulty>("medium");
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const write = async () => {
    if (topic.trim().length < 2) return setError("Type what the problem should be about.");
    setError(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const problem = await prepareProblem(topic.trim(), difficulty, setStep, ctrl.signal);
      if (!ctrl.signal.aborted) onDone(problem);
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === ctrl) abort.current = null;
      setStep(null);
    }
  };
  const at = step ? STEPS.findIndex((s) => s.id === step) : -1;

  return (
    <section aria-label="Write the problem from a topic" className="rounded-xl border border-accent/30 bg-accent/[0.06] p-3.5">
      <div className="flex items-center gap-2">
        <PenLine className="size-4 text-accent-ink" />
        <h3 className="text-[13px] font-semibold text-fg">Write it for me</h3>
        <span className="text-xs text-fg-subtle">Type a topic; the statement and tests are filled in, every answer checked by running it.</span>
      </div>
      <form
        className="mt-2.5 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!step) void write();
        }}
      >
        <input
          value={topic}
          maxLength={300}
          disabled={!!step || disabled}
          onChange={(e) => setTopic(e.target.value)}
          aria-label="Problem topic"
          placeholder="e.g. prime numbers, two sum, longest palindrome"
          className={cn(field, "h-9 min-w-0 flex-1 basis-64 py-0")}
        />
        <div role="radiogroup" aria-label="Difficulty" className="flex h-9 shrink-0 rounded-lg border border-line-strong/70 bg-surface-2 p-0.5">
          {(["easy", "medium", "hard"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={difficulty === d}
              disabled={!!step}
              onClick={() => setDifficulty(d)}
              className={cn("rounded-md px-2.5 text-xs font-medium capitalize transition-colors", difficulty === d ? "bg-accent text-accent-fg" : "text-fg-muted hover:text-fg")}
            >
              {d}
            </button>
          ))}
        </div>
        {step ? (
          <Button className="h-9" onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" variant="primary" className="h-9 px-4" disabled={disabled}>
            Write problem
          </Button>
        )}
      </form>
      {step && (
        <ol aria-label="Progress" className="mt-3 space-y-1.5">
          {STEPS.map((s, i) => (
            <li key={s.id} className={cn("flex items-center gap-2 text-xs", i < at ? "text-fg-muted" : i === at ? "text-fg" : "text-fg-faint")}>
              {i < at ? <Check className="size-3.5 text-success" /> : i === at ? <Spinner className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {s.text}
            </li>
          ))}
        </ol>
      )}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </section>
  );
}

function SetupForm({ mode }: { mode: "create" | "edit" }) {
  const live = useLive.getState();
  const current = live.interview;
  const project = useWorkspace.getState().project;
  const [name, setName] = useState(live.name || "");
  const [language, setLanguage] = useState(project?.language ?? LANGUAGES[0]!.id);
  const [duration, setDuration] = useState(current?.durationMin ?? 45);
  const [maxLeaves, setMaxLeaves] = useState<number>(current ? (current.maxLeaves ?? 0) : INTERVIEW_LIMITS.defaultMaxLeaves);
  const [title, setTitle] = useState(current?.title ?? "");
  const [statement, setStatement] = useState(current?.statement ?? "");
  const [samples, setSamples] = useState<InterviewTest[]>(mode === "edit" ? (current?.samples ?? project?.tests ?? []).map((t) => ({ ...t })) : []);
  const [hidden, setHidden] = useState<InterviewTest[]>(mode === "edit" ? (live.interviewPrivate?.hiddenTests ?? []).map((t) => ({ ...t })) : []);
  const [solution, setSolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = !!current?.startedAt;

  const submit = async () => {
    if (!title.trim()) return setError("Give the problem a title.");
    if (mode === "create" && !name.trim()) return setError("Type your name; the candidate sees it.");
    setError(null);
    // The candidate sees the sample tests: no notes.
    const sampleTests = samples.filter((t) => t.input.trim() || t.expected.trim()).map(({ id, input, expected }) => ({ id, input, expected }));
    const setup: InterviewSetup = {
      title: title.trim(),
      statement,
      durationMin: duration,
      samples: sampleTests,
      hiddenTests: hidden.filter((t) => t.input.trim() || t.expected.trim()),
      maxLeaves,
    };
    if (mode === "edit") {
      useWorkspace.getState().setTests(sampleTests);
      useLive.getState().sendInterview({ type: "interview-setup", setup });
      toast.success("Interview updated");
      useInterviewUI.getState().closeSetup();
      return;
    }
    setBusy(true);
    await useWorkspace.getState().createProject(language, setup.title);
    if (sampleTests.length) useWorkspace.getState().setTests(sampleTests);
    await useWorkspace.getState().flush();
    const ok = await useLive.getState().startInterview(name, setup);
    setBusy(false);
    if (!ok) return setError(useLive.getState().error ?? "Could not start the interview.");
    useSettings.getState().updateLayout({ assistantOpen: true });
    useInterviewUI.getState().closeSetup();
    toast.success("Interview ready", "Send the link to the candidate from the Overview tab.");
  };

  return (
    <div className="space-y-5">
      <Writer
        disabled={busy}
        onDone={(p) => {
          setTitle(p.title.slice(0, INTERVIEW_LIMITS.maxTitleChars));
          setStatement(p.statement.slice(0, INTERVIEW_LIMITS.maxStatementChars));
          setSamples(p.samples.slice(0, Math.min(6, TEST_LIMITS.maxTests)));
          setHidden(p.hidden.slice(0, INTERVIEW_LIMITS.maxHiddenTests));
          setSolution(p.solution);
          setError(null);
        }}
      />
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {mode === "create" && (
            <label className="block space-y-1">
              <span className={label}>Your name</span>
              <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya (HR)" className={cn(select, "px-3")} />
            </label>
          )}
          {mode === "create" && (
            <label className="block space-y-1">
              <span className={label}>Language</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} className={select} aria-label="Language">
                {/* A candidate's code is checked by running it on tests: a page that runs in the browser cannot be. */}
                {LANGUAGES.filter((l) => !l.preview).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block space-y-1">
            <span className={label}>Time</span>
            <select value={duration} disabled={started} onChange={(e) => setDuration(Number(e.target.value))} className={select} aria-label="Duration">
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} minutes
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className={label}>If the candidate leaves the window</span>
            <select value={maxLeaves} onChange={(e) => setMaxLeaves(Number(e.target.value))} className={select} aria-label="Leaving the window">
              <option value={1}>End the interview at once</option>
              <option value={3}>End it the 3rd time</option>
              <option value={5}>End it the 5th time</option>
              <option value={0}>Only tell me</option>
            </select>
          </label>
        </div>
        <label className="block space-y-1">
          <span className={label}>Problem title</span>
          <Input value={title} maxLength={INTERVIEW_LIMITS.maxTitleChars} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Find the two numbers that add up to a target" className={cn(select, "px-3")} />
        </label>
        <label className="block space-y-1">
          <span className={label}>Problem statement (the candidate sees this)</span>
          <textarea
            value={statement}
            maxLength={INTERVIEW_LIMITS.maxStatementChars}
            rows={statement ? 12 : 6}
            onChange={(e) => setStatement(e.target.value)}
            placeholder={"Describe the task, the input format and the expected output.\n\nExample input:\n4\n1 2 3 4\n7\n\nExpected output:\n2 3"}
            className={cn(field, "resize-y leading-relaxed")}
          />
        </label>
        <TestList label="Sample tests" hint="The candidate sees these; Run checks the code against them." icon={<Eye className="size-4 text-fg-subtle" />} tests={samples} onChange={setSamples} max={Math.min(6, TEST_LIMITS.maxTests)} />
        <TestList
          label="Hidden tests"
          hint="Only you see these. Submit checks the candidate's code against them and tells the candidate the score, never the tests. Large inputs show how the code scales."
          icon={<EyeOff className="size-4 text-fg-subtle" />}
          tests={hidden}
          onChange={setHidden}
          max={INTERVIEW_LIMITS.maxHiddenTests}
        />
        {solution && (
          <details className="group rounded-lg border border-line-strong/50 bg-surface/50">
            <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-fg-muted hover:text-fg">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              Reference solution (Python), for you only
            </summary>
            <pre className="max-h-72 overflow-auto border-t border-line-strong/50 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg">{solution}</pre>
          </details>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 rounded-b-lg border-t border-line bg-overlay px-4 py-3">
          <Button variant="ghost" onClick={() => useInterviewUI.getState().closeSetup()}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy} icon={busy ? <Spinner /> : undefined}>
            {mode === "create" ? "Create interview" : "Save changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Prepare an interview (or change the problem and tests of the running one). */
export function InterviewSetupDialog() {
  const mode = useInterviewUI((s) => s.setup);
  return (
    <Dialog
      open={!!mode}
      onOpenChange={(open) => !open && useInterviewUI.getState().closeSetup()}
      title={mode === "edit" ? "Edit the interview" : "Start a coding interview"}
      description={
        mode === "edit"
          ? "Changes reach the candidate immediately. Hidden tests stay private."
          : "The candidate works in a locked full-screen window: no copy and paste, no code suggestions, no other tools. You see their code, runs and submissions live."
      }
      className="top-[5vh] max-h-[90vh] max-w-3xl overflow-y-auto"
    >
      {mode && <SetupForm key={mode} mode={mode} />}
    </Dialog>
  );
}
