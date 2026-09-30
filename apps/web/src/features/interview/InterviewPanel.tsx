"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Download,
  FileText,
  FlaskConical,
  Gauge,
  NotebookPen,
  Pencil,
  Play,
  Printer,
  Rewind,
  Star,
  X,
  XCircle,
} from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/primitives";
import { useWorkspace } from "@/features/projects/store";
import { useLive } from "@/features/live/store";
import { InviteBox } from "@/features/live/LiveUI";
import { cn } from "@/lib/cn";
import { formatDuration, formatRemaining } from "./monitor";
import { InterviewClock } from "./Clock";
import { buildReport, describeEvent, downloadReport, printReport, summarize, WARN } from "./report";
import { codeKeyOf, measuredGrowth, useInterviewTools } from "./store";
import { useInterviewUI } from "./ui";

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
      <ClipboardList className="size-4 text-accent" />
      <h2 className="text-sm font-semibold">{title}</h2>
      <InterviewClock className="ml-auto text-[13px]" />
      <IconButton label="Close panel" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------- candidate

function CandidatePanel({ onClose }: { onClose: () => void }) {
  const iv = useLive((s) => s.interview)!;
  const role = useLive((s) => s.role);
  const [confirm, setConfirm] = useState(false);
  return (
    <section aria-label="Interview" className="flex h-full min-h-0 flex-col bg-surface">
      <Header title="Problem" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <h3 className="text-[17px] font-semibold leading-snug">{iv.title}</h3>
          <p className="mt-2 whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg-muted">{iv.statement || "The interviewer will explain the problem."}</p>
        </div>
        <div className="rounded-lg border border-line-strong/60 p-3 text-[12.5px] leading-relaxed text-fg-muted">
          <p className="font-medium text-fg">You can use</p>
          <p>The editor, Run (Ctrl+Enter), Program input and the sample tests.</p>
          <p className="mt-2 font-medium text-fg">Not available</p>
          <p>Debugger, visualizer and AI help.</p>
          <p className="mt-2 text-fg-subtle">The interviewer sees your code as you type, your runs, and when you leave this tab, the window or full screen, or paste text.</p>
        </div>
        {iv.endedAt ? (
          <p className="flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success">
            <CheckCircle2 className="size-4" /> The interview has ended. Your code has been handed in.
          </p>
        ) : role !== "viewer" && iv.startedAt ? (
          confirm ? (
            <div className="space-y-2 rounded-lg border border-line-strong p-3 text-sm">
              <p>Hand in your code now? You cannot change it afterwards.</p>
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
            <Button variant="secondary" onClick={() => setConfirm(true)}>
              I have finished
            </Button>
          )
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- interviewer

type Tab = "overview" | "activity" | "tests" | "complexity" | "notes" | "report";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <ClipboardList /> },
  { id: "activity", label: "Activity", icon: <Activity /> },
  { id: "tests", label: "Hidden tests", icon: <FlaskConical /> },
  { id: "complexity", label: "Complexity", icon: <Gauge /> },
  { id: "notes", label: "Notes", icon: <NotebookPen /> },
  { id: "report", label: "Report", icon: <FileText /> },
];

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2", warn ? "border-warning/50 bg-warning-soft" : "border-line-strong/60")}>
      <div className={cn("text-lg font-semibold tabular-nums", warn && "text-warning")}>{value}</div>
      <div className="text-[11.5px] text-fg-subtle">{label}</div>
    </div>
  );
}

function Overview() {
  const iv = useLive((s) => s.interview)!;
  const priv = useLive((s) => s.interviewPrivate);
  const participants = useLive((s) => s.participants);
  const roomId = useLive((s) => s.roomId);
  const candidateOnline = participants.some((p) => p.role !== "owner");
  const sum = summarize(priv?.events ?? []);
  const [confirm, setConfirm] = useState(false);
  const send = useLive.getState().sendInterview;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("size-2 rounded-full", candidateOnline ? "bg-success" : "bg-fg-faint")} />
        <span className="text-sm">
          {iv.candidate ? (
            <>
              <b>{iv.candidate}</b> {candidateOnline ? "is connected" : "is not connected"}
            </>
          ) : (
            "Waiting for the candidate to open the link"
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line-strong/60 p-3">
        <InterviewClock className="text-base" />
        {iv.startedAt && !iv.endedAt && (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {[5, 10, 15].map((m) => (
              <Button key={m} size="sm" variant="secondary" onClick={() => send({ type: "interview-extend", minutes: m })}>
                +{m} min
              </Button>
            ))}
          </span>
        )}
        {!iv.startedAt && <span className="text-xs text-fg-subtle">The clock starts when the candidate agrees to the rules.</span>}
      </div>
      {!iv.endedAt &&
        (confirm ? (
          <div className="space-y-2 rounded-lg border border-danger/40 p-3 text-sm">
            <p>End the interview now? The candidate&apos;s code is locked.</p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => send({ type: "interview-end" })}>
                End interview
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Pencil className="size-3.5" />} onClick={() => useInterviewUI.getState().openSetup("edit")}>
              Edit problem &amp; tests
            </Button>
            <Button variant="ghost" className="text-danger" onClick={() => setConfirm(true)}>
              End interview
            </Button>
          </div>
        ))}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Integrity</h3>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Tab switches" value={sum.tabSwitches} warn={sum.tabSwitches > 0} />
          <Stat label="Window switches" value={sum.windowSwitches} warn={sum.windowSwitches > 0} />
          <Stat label="Time away" value={formatDuration(sum.awayMs)} warn={sum.awayMs > 30_000} />
          <Stat label="Left full screen" value={sum.fullscreenExits} warn={sum.fullscreenExits > 0} />
          <Stat label={`Pastes (${sum.pastedChars} chars)`} value={sum.pastes} warn={sum.largePastes > 0} />
          <Stat label="Runs" value={sum.runs} />
        </div>
        {sum.blocked > 0 && <p className="mt-2 text-xs text-warning">Tried a blocked tool {sum.blocked} time(s).</p>}
      </div>

      {roomId && !iv.endedAt && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Invite the candidate</h3>
          <InviteBox roomId={roomId} />
        </div>
      )}
    </div>
  );
}

function Timeline() {
  const iv = useLive((s) => s.interview)!;
  const events = useLive((s) => s.interviewPrivate?.events ?? []);
  const [onlyFlags, setOnlyFlags] = useState(false);
  const list = [...events].reverse().filter((e) => !onlyFlags || WARN.has(e.kind));
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input type="checkbox" checked={onlyFlags} onChange={(e) => setOnlyFlags(e.target.checked)} className="accent-[var(--accent)]" />
        Only things to look at (tab, window, full screen, pastes)
      </label>
      {list.length === 0 && <p className="text-sm text-fg-subtle">Nothing yet. Activity appears here as it happens.</p>}
      <ol aria-label="Activity" className="space-y-1">
        {list.map((e) => (
          <li key={`${e.t}-${e.kind}`} className={cn("rounded-md px-2.5 py-1.5 text-[12.5px]", WARN.has(e.kind) ? "bg-warning-soft" : "hover:bg-hover")}>
            <div className="flex gap-2">
              <span className="shrink-0 font-mono text-fg-subtle">{iv.startedAt && e.t >= iv.startedAt ? `+${formatRemaining(e.t - iv.startedAt)}` : new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              <span className={cn(WARN.has(e.kind) && "text-warning")}>{describeEvent(e)}</span>
            </div>
            {e.kind === "paste" && e.detail && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-[11.5px] text-fg-muted">{e.detail}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function HiddenTests() {
  const project = useWorkspace((s) => s.project);
  const tests = useLive((s) => s.interviewPrivate?.hiddenTests ?? []);
  const hidden = useInterviewTools((s) => s.hidden);
  const stale = !!project && !!hidden.codeKey && hidden.codeKey !== codeKeyOf(project);
  const passed = hidden.results?.filter((r) => r.comparison.verdict === "passed").length ?? 0;
  const [open, setOpen] = useState<string | null>(null);
  if (!tests.length) {
    return (
      <div className="space-y-3 text-sm text-fg-muted">
        <p>Hidden tests check the candidate&apos;s code on inputs they never see. They run automatically after each successful run of the candidate.</p>
        <Button variant="secondary" onClick={() => useInterviewUI.getState().openSetup("edit")}>
          Add hidden tests
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="primary" icon={hidden.running ? <Spinner /> : <Play className="size-3.5" />} disabled={hidden.running || !project} onClick={() => project && void useInterviewTools.getState().runHidden(project, tests)}>
          Run {tests.length} hidden test{tests.length === 1 ? "" : "s"}
        </Button>
        {hidden.results && (
          <span className={cn("text-sm font-semibold", passed === hidden.results.length ? "text-success" : "text-danger")}>
            {passed} / {hidden.results.length} passed
          </span>
        )}
      </div>
      {stale && <p className="text-xs text-warning">The code changed since these results. Run again for the current code.</p>}
      {hidden.compileError && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-danger/10 p-2 font-mono text-[11.5px] text-danger">{hidden.compileError}</pre>}
      {hidden.error && <p className="text-xs text-danger">{hidden.error}</p>}
      <ul className="space-y-1">
        {tests.map((t, i) => {
          const r = hidden.results?.find((x) => x.test.id === t.id);
          const ok = r?.comparison.verdict === "passed";
          return (
            <li key={t.id} className="rounded-md border border-line-strong/50">
              <button type="button" onClick={() => setOpen(open === t.id ? null : t.id)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]">
                {r ? ok ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-danger" /> : <span className="size-4 rounded-full border border-line-strong" />}
                Hidden test {i + 1}
                <span className="ml-auto text-xs text-fg-subtle">{r ? `${r.comparison.verdict}${r.run?.executionTime !== undefined ? ` · ${r.run.executionTime} ms` : ""}` : "not run"}</span>
              </button>
              {open === t.id && (
                <div className="grid gap-2 border-t border-line-strong/50 p-2.5 text-[11.5px]">
                  {[
                    ["Input", t.input],
                    ["Expected", t.expected],
                    ["Output", r?.run?.stdout ?? ""],
                    ...(r?.run?.stderr ? [["Errors", r.run.stderr]] : []),
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div className="mb-0.5 font-medium text-fg-subtle">{k}</div>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-fg-muted">{v || "(empty)"}</pre>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Complexity() {
  const project = useWorkspace((s) => s.project);
  const c = useInterviewTools((s) => s.complexity);
  const hidden = useInterviewTools((s) => s.hidden);
  const growth = useMemo(() => (hidden.results ? measuredGrowth(hidden.results) : null), [hidden.results]);
  const stale = !!project && !!c.codeKey && c.codeKey !== codeKeyOf(project);
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-fg-subtle">Estimates only: no tool can work out the exact complexity of every program. Use them as a starting point for your questions.</p>
      <div className="space-y-2">
        <Button variant="primary" icon={c.loading ? <Spinner /> : <Gauge className="size-3.5" />} disabled={c.loading || !project} onClick={() => project && void useInterviewTools.getState().analyze(project)}>
          {c.estimate ? "Analyse again" : "Analyse the code"}
        </Button>
        {c.error && <p className="text-xs text-danger">{c.error}</p>}
        {c.estimate && (
          <div className="space-y-2 rounded-lg border border-line-strong/60 p-3">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-accent/15 px-2.5 py-1 font-mono text-[13px] font-semibold text-accent">Time {c.estimate.time}</span>
              <span className="rounded-full bg-accent/15 px-2.5 py-1 font-mono text-[13px] font-semibold text-accent">Space {c.estimate.space}</span>
            </div>
            <p className="text-[13px] leading-relaxed text-fg-muted">{c.estimate.explanation}</p>
            {stale && <p className="text-xs text-warning">The code changed since this analysis.</p>}
          </div>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Measured on the hidden tests</h3>
        {!growth || growth.points.length === 0 ? (
          <p className="text-xs text-fg-subtle">Run the hidden tests. With inputs of growing size (for example n = 1 000, 10 000, 100 000), their times show how the program scales.</p>
        ) : (
          <>
            {growth.label ? (
              <p className="text-sm">
                Grows like <b>{growth.label}</b> <span className="text-fg-subtle">(time ∝ size^{growth.exponent})</span>
              </p>
            ) : (
              <p className="text-xs text-fg-subtle">Not enough spread in input sizes or times to estimate growth (needs 3+ tests, sizes 8× apart, and a slowest test above 20 ms).</p>
            )}
            <table className="mt-2 w-full text-left text-[12px]">
              <thead className="text-fg-subtle">
                <tr>
                  <th className="py-1 font-medium">Input size</th>
                  <th className="py-1 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {growth.points.map((p, i) => (
                  <tr key={i} className="border-t border-line-strong/40">
                    <td className="py-1 font-mono">{p.size.toLocaleString()} bytes</td>
                    <td className="py-1 font-mono">{p.ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function Notes() {
  const priv = useLive((s) => s.interviewPrivate);
  const [notes, setNotes] = useState(priv?.notes ?? "");
  const [rating, setRating] = useState(priv?.rating ?? 0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = (n: string, r: number) => {
    // Kept here at once (the report reads it); sent to the server shortly after typing stops.
    useLive.setState((s) => ({ interviewPrivate: s.interviewPrivate ? { ...s.interviewPrivate, notes: n, rating: r } : s.interviewPrivate }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => useLive.getState().sendInterview({ type: "interview-notes", notes: n, rating: r }), 600);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-subtle">Only you see these. They are saved as you type and included in the report.</p>
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} star${n === 1 ? "" : "s"}`}
            onClick={() => {
              const r = rating === n ? 0 : n;
              setRating(r);
              save(notes, r);
            }}
          >
            <Star className={cn("size-5", n <= rating ? "fill-warning text-warning" : "text-fg-faint")} />
          </button>
        ))}
      </div>
      <textarea
        aria-label="Interviewer notes"
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          save(e.target.value, rating);
        }}
        rows={12}
        placeholder="Strengths, concerns, how they explained their approach…"
        className="w-full resize-y rounded-lg border border-line-strong/70 bg-surface-2 p-3 text-[13px] leading-relaxed outline-none focus:border-accent"
      />
    </div>
  );
}

function Report() {
  const project = useWorkspace((s) => s.project);
  const iv = useLive((s) => s.interview)!;
  const priv = useLive((s) => s.interviewPrivate);
  const name = useLive((s) => s.name);
  const hidden = useInterviewTools((s) => s.hidden);
  const complexity = useInterviewTools((s) => s.complexity);
  const report = () =>
    project && priv
      ? buildReport({
          interview: iv,
          priv,
          interviewer: name,
          project,
          hidden: hidden.results,
          hiddenCompileError: hidden.compileError,
          complexity: complexity.estimate,
          growth: hidden.results ? measuredGrowth(hidden.results) : undefined,
        })
      : null;
  return (
    <div className="space-y-3">
      <Button variant="primary" icon={<Rewind className="size-3.5" />} onClick={() => useInterviewUI.getState().setReplayOpen(true)}>
        Replay the coding
      </Button>
      <p className="text-xs text-fg-subtle">Watch how the code was written, keystroke by keystroke, with tab switches and pastes marked.</p>
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button
          variant="secondary"
          icon={<Download className="size-3.5" />}
          onClick={() => {
            const html = report();
            if (html) downloadReport(html, `${iv.candidate ?? "candidate"}-${iv.title}`);
          }}
        >
          Download report
        </Button>
        <Button
          variant="ghost"
          icon={<Printer className="size-3.5" />}
          onClick={() => {
            const html = report();
            if (html) printReport(html);
          }}
        >
          Print / Save as PDF
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">The report has the summary, integrity signals, hidden test results, complexity, your notes and rating, the final code and the full timeline. Run the hidden tests and the analysis first to include them.</p>
      {!iv.endedAt && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertTriangle className="size-3.5" /> The interview is still going; the report shows the state right now.
        </p>
      )}
    </div>
  );
}

function InterviewerPanel({ onClose }: { onClose: () => void }) {
  const iv = useLive((s) => s.interview)!;
  const [tab, setTab] = useState<Tab>("overview");
  const flags = useLive((s) => (s.interviewPrivate?.events ?? []).filter((e) => WARN.has(e.kind)).length);
  return (
    <section aria-label="Interview" className="flex h-full min-h-0 flex-col bg-surface">
      <Header title={iv.title} onClose={onClose} />
      <div role="tablist" aria-label="Interview" className="flex shrink-0 flex-wrap gap-0.5 border-b border-line px-1.5 py-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors [&_svg]:size-3.5",
              tab === t.id ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {t.icon}
            {t.label}
            {t.id === "activity" && flags > 0 && <span className="rounded-full bg-warning px-1.5 text-[10.5px] font-semibold text-black">{flags}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "overview" && <Overview />}
        {tab === "activity" && <Timeline />}
        {tab === "tests" && <HiddenTests />}
        {tab === "complexity" && <Complexity />}
        {tab === "notes" && <Notes />}
        {tab === "report" && <Report />}
      </div>
    </section>
  );
}

/** Right-hand panel in an interview: the interviewer's tools, or the problem for the candidate. */
export function InterviewPanel({ onClose }: { onClose: () => void }) {
  const iv = useLive((s) => s.interview);
  const role = useLive((s) => s.role);
  if (!iv) return null;
  return role === "owner" ? <InterviewerPanel onClose={onClose} /> : <CandidatePanel onClose={onClose} />;
}
