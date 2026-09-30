"use client";

import { useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { INTERVIEW_LIMITS, LANGUAGES, TEST_LIMITS, type InterviewSetup, type InterviewTest } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { createId } from "@/lib/id";
import { cn } from "@/lib/cn";
import { useInterviewUI } from "./ui";

const DURATIONS = [15, 30, 45, 60, 90, 120];
const field = "w-full rounded-lg border border-line-strong/70 bg-surface-2 px-3 py-2 text-[13px] outline-none focus:border-accent";
const select = "h-7 w-full rounded-[4px] border border-line-strong bg-surface-2 px-2 text-sm text-fg outline-none focus:border-accent";

function TestList({ label, hint, icon, tests, onChange, max }: { label: string; hint: string; icon: React.ReactNode; tests: InterviewTest[]; onChange: (t: InterviewTest[]) => void; max: number }) {
  return (
    <fieldset className="space-y-2">
      <legend className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        {icon}
        {label}
      </legend>
      <p className="text-[11.5px] text-fg-subtle">{hint}</p>
      {tests.map((t, i) => (
        <div key={t.id} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
          <textarea
            aria-label={`${label} ${i + 1} input`}
            value={t.input}
            rows={2}
            placeholder="Input"
            onChange={(e) => onChange(tests.map((x) => (x.id === t.id ? { ...x, input: e.target.value } : x)))}
            className={cn(field, "resize-y font-mono text-[12px]")}
          />
          <textarea
            aria-label={`${label} ${i + 1} expected output`}
            value={t.expected}
            rows={2}
            placeholder="Expected output"
            onChange={(e) => onChange(tests.map((x) => (x.id === t.id ? { ...x, expected: e.target.value } : x)))}
            className={cn(field, "resize-y font-mono text-[12px]")}
          />
          <button type="button" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(tests.filter((x) => x.id !== t.id))} className="mt-1.5 rounded p-1 text-fg-subtle hover:bg-danger/15 hover:text-danger">
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
      {tests.length < max && (
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...tests, { id: createId(), input: "", expected: "" }])}>
          Add {label.toLowerCase().replace(/s$/, "")}
        </Button>
      )}
    </fieldset>
  );
}

function SetupForm({ mode }: { mode: "create" | "edit" }) {
  const live = useLive.getState();
  const current = live.interview;
  const project = useWorkspace.getState().project;
  const [name, setName] = useState(live.name || "");
  const [language, setLanguage] = useState(project?.language ?? "java");
  const [duration, setDuration] = useState(current?.durationMin ?? 45);
  const [title, setTitle] = useState(current?.title ?? "");
  const [statement, setStatement] = useState(current?.statement ?? "");
  const [samples, setSamples] = useState<InterviewTest[]>(mode === "edit" ? (project?.tests ?? []).map((t) => ({ ...t })) : []);
  const [hidden, setHidden] = useState<InterviewTest[]>(mode === "edit" ? (live.interviewPrivate?.hiddenTests ?? []).map((t) => ({ ...t })) : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = !!current?.startedAt;

  const submit = async () => {
    if (!title.trim()) return setError("Give the problem a title.");
    if (mode === "create" && !name.trim()) return setError("Type your name; the candidate sees it.");
    setError(null);
    const setup: InterviewSetup = {
      title: title.trim(),
      statement,
      durationMin: duration,
      hiddenTests: hidden.filter((t) => t.input.trim() || t.expected.trim()),
    };
    const sampleTests = samples.filter((t) => t.input.trim() || t.expected.trim());
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
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {mode === "create" && (
          <label className="block space-y-1 sm:col-span-1">
            <span className="text-xs font-medium text-fg-muted">Your name</span>
            <Input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya (HR)" />
          </label>
        )}
        {mode === "create" && (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-fg-muted">Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={select} aria-label="Language">
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium text-fg-muted">Time</span>
          <select value={duration} disabled={started} onChange={(e) => setDuration(Number(e.target.value))} className={select} aria-label="Duration">
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d} minutes
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-fg-muted">Problem title</span>
        <Input value={title} maxLength={INTERVIEW_LIMITS.maxTitleChars} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Find the two numbers that add up to a target" />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-fg-muted">Problem statement (the candidate sees this)</span>
        <textarea
          value={statement}
          maxLength={INTERVIEW_LIMITS.maxStatementChars}
          rows={6}
          onChange={(e) => setStatement(e.target.value)}
          placeholder={"Describe the task, the input format and the expected output.\n\nExample input:\n4\n1 2 3 4\n7\n\nExpected output:\n2 3"}
          className={cn(field, "resize-y leading-relaxed")}
        />
      </label>
      <TestList label="Sample tests" hint="The candidate sees these and can run them." icon={<Eye className="size-3.5" />} tests={samples} onChange={setSamples} max={Math.min(6, TEST_LIMITS.maxTests)} />
      <TestList
        label="Hidden tests"
        hint="Only you see these. They run on the candidate's code after each successful run. Inputs of growing size (n = 1 000, 10 000, 100 000) also show how the code scales."
        icon={<EyeOff className="size-3.5" />}
        tests={hidden}
        onChange={setHidden}
        max={INTERVIEW_LIMITS.maxHiddenTests}
      />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <Button variant="ghost" onClick={() => useInterviewUI.getState().closeSetup()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy} icon={busy ? <Spinner /> : undefined}>
          {mode === "create" ? "Create interview" : "Save changes"}
        </Button>
      </div>
    </form>
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
          : "The candidate gets the editor, Run and your sample tests only: no debugger, visualizer or AI. You see their code, runs, tab switches and pastes live."
      }
      className="max-h-[88vh] max-w-2xl overflow-y-auto top-[6vh]"
    >
      {mode && <SetupForm key={mode} mode={mode} />}
    </Dialog>
  );
}
