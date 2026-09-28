"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Check, Circle, CircleCheck, CircleDashed, CircleDot, CircleX, Copy, FlaskConical, Loader2, OctagonAlert, Play, Plus, Square, Timer, Trash2, Wand2 } from "lucide-react";
import { READ_INPUT_EXAMPLE, TEST_LIMITS, basename, readsInput, type TestCase } from "@cw/shared";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { primaryShortcut } from "@/features/commands/registry";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { diffRows, firstCharDiff, judge, type Verdict } from "./compare";
import { useLastRunAsTest, useTests, type TestOutcome } from "./store";

const EMPTY: TestCase[] = [];

type Shown = Verdict | "queued" | "running" | "not-run" | "stale";

const LOOK: Record<Shown, { label: string; icon: React.ReactNode; tone: string }> = {
  passed: { label: "Passed", icon: <CircleCheck />, tone: "text-success" },
  failed: { label: "Wrong answer", icon: <CircleX />, tone: "text-danger" },
  "time-limit": { label: "Time limit", icon: <Timer />, tone: "text-warning" },
  crashed: { label: "Runtime error", icon: <OctagonAlert />, tone: "text-danger" },
  error: { label: "Did not run", icon: <OctagonAlert />, tone: "text-danger" },
  "compile-error": { label: "Compile error", icon: <OctagonAlert />, tone: "text-danger" },
  ran: { label: "Ran", icon: <CircleDot />, tone: "text-info" },
  queued: { label: "Waiting", icon: <CircleDashed />, tone: "text-fg-faint" },
  running: { label: "Running", icon: <Loader2 className="animate-spin" />, tone: "text-accent" },
  "not-run": { label: "Not run", icon: <Circle />, tone: "text-fg-faint" },
  stale: { label: "Input changed", icon: <Circle />, tone: "text-fg-subtle" },
};

function shownState(test: TestCase, outcome: TestOutcome | undefined): Shown {
  if (!outcome) return "not-run";
  if (outcome.state !== "done") return outcome.state;
  if (outcome.input !== test.input) return "stale";
  return judge(outcome.result!.status, test.expected, outcome.result!.stdout).verdict;
}

function ms(n: number | undefined): string {
  if (n === undefined) return "";
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(2)} s`;
}

/** Tests tool window: saved inputs with expected output, run together and checked line by line. */
export function TestsPanel() {
  const tests = useWorkspace((s) => s.project?.tests ?? EMPTY);
  const selected = useTests((s) => s.selected);
  const select = useTests((s) => s.select);
  const current = tests.find((t) => t.id === selected) ?? tests[0];

  useEffect(() => {
    if (tests.length && !tests.some((t) => t.id === selected)) select(tests[0]!.id);
  }, [tests, selected, select]);

  if (!tests.length) return <NoTests />;
  return (
    <div className="flex h-full min-h-0">
      <TestList tests={tests} current={current?.id} />
      {current && <TestDetail key={current.id} test={current} number={tests.indexOf(current) + 1} />}
    </div>
  );
}

function RunAllButton({ compact }: { compact?: boolean }) {
  const phase = useTests((s) => s.phase);
  const run = useTests((s) => s.run);
  const cancel = useTests((s) => s.cancel);
  const shortcut = primaryShortcut("tests.runAll");
  if (phase !== "idle") {
    return (
      <button
        type="button"
        onClick={() => void cancel()}
        className="flex h-7 items-center gap-1.5 rounded-full bg-danger/90 px-3 text-[12.5px] font-medium text-white transition-transform hover:brightness-110 active:scale-95"
      >
        <Square className="size-3 fill-current" /> Stop
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void run()}
      title={shortcut ? undefined : "Run all tests"}
      className="group flex h-7 items-center gap-1.5 rounded-full bg-success px-3 text-[12.5px] font-medium text-white shadow-[0_4px_14px_-6px_var(--success)] transition-transform hover:brightness-110 active:scale-95"
    >
      <Play className="size-3.5 fill-current" /> Run all
      {!compact && shortcut && <Kbd shortcut={shortcut} className="ml-0.5 border-white/30 bg-white/15 text-white/90" />}
    </button>
  );
}

function PhaseLine() {
  const phase = useTests((s) => s.phase);
  const error = useTests((s) => s.error);
  const compileError = useTests((s) => s.compileError);
  if (phase === "starting") return <p className="text-xs text-fg-subtle">Starting…</p>;
  if (phase === "compiling") return <p className="text-xs text-fg-subtle">Compiling…</p>;
  if (compileError) return <p className="text-xs text-danger">Didn’t compile</p>;
  if (error) return <p className="line-clamp-2 text-xs text-danger">{error}</p>;
  return null;
}

/** Left column: one row per test with its verdict, and a strip summarising the run. */
function TestList({ tests, current }: { tests: TestCase[]; current?: string }) {
  const outcomes = useTests((s) => s.outcomes);
  const select = useTests((s) => s.select);
  const add = useTests((s) => s.add);
  const states = tests.map((t) => shownState(t, outcomes[t.id]));
  const judged = states.filter((s) => s !== "not-run" && s !== "stale" && s !== "queued" && s !== "running" && s !== "ran");
  const passed = states.filter((s) => s === "passed").length;
  const listRef = useRef<HTMLDivElement>(null);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = tests.findIndex((t) => t.id === current);
    const next = tests[Math.max(0, Math.min(tests.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      select(next.id);
      listRef.current?.querySelector<HTMLElement>(`[data-test="${next.id}"]`)?.focus();
    }
  };

  return (
    <aside className="flex w-[228px] shrink-0 flex-col border-r border-line bg-canvas">
      <div className="flex flex-col gap-2 border-b border-line px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <RunAllButton compact />
          <span className="text-xs tabular-nums text-fg-subtle" aria-live="polite">
            {judged.length ? (
              <>
                <span className={passed === judged.length ? "font-medium text-success" : "font-medium text-fg"}>{passed}</span> / {judged.length} passed
              </>
            ) : (
              `${tests.length} ${tests.length === 1 ? "test" : "tests"}`
            )}
          </span>
        </div>
        <div className="flex h-1.5 gap-[3px]" aria-hidden>
          {states.map((s, i) => (
            <span
              key={tests[i]!.id}
              className={cn(
                "flex-1 rounded-full transition-colors duration-300",
                s === "passed" ? "bg-success" : s === "failed" || s === "crashed" || s === "error" ? "bg-danger" : s === "time-limit" ? "bg-warning" : s === "running" ? "animate-pulse bg-accent" : s === "ran" ? "bg-info/60" : "bg-line-strong/70",
              )}
            />
          ))}
        </div>
        <PhaseLine />
      </div>
      <div ref={listRef} role="listbox" aria-label="Tests" className="min-h-0 flex-1 overflow-y-auto p-1.5" onKeyDown={onKey}>
        {tests.map((t, i) => {
          const s = states[i]!;
          const look = LOOK[s];
          const o = outcomes[t.id];
          const active = t.id === current;
          return (
            <div
              key={t.id}
              data-test={t.id}
              role="option"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => e.key === "Enter" && select(t.id)}
              className={cn(
                "group flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors",
                active ? "bg-accent-soft/70 text-fg" : "text-fg-muted hover:bg-hover",
                "focus-visible:ring-1 focus-visible:ring-accent",
              )}
            >
              <motion.span key={s} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 22 }} className={cn("flex [&_svg]:size-4", look.tone)}>
                {look.icon}
              </motion.span>
              <span className="min-w-0 flex-1">
                <span className="block truncate leading-4">Test {i + 1}</span>
                <span className={cn("block truncate text-[11px] leading-4", s === "not-run" ? "text-fg-faint" : look.tone)}>
                  {s === "not-run" ? preview(t.input) : look.label}
                </span>
              </span>
              {o?.state === "done" && s !== "stale" && <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">{ms(o.result?.executionTime)}</span>}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => add()}
          disabled={tests.length >= TEST_LIMITS.maxTests}
          className="mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
        >
          <Plus className="size-4" /> Add test
        </button>
      </div>
    </aside>
  );
}

function preview(input: string): string {
  const line = input.trim().split("\n")[0]?.trim();
  return line ? line : "No input";
}

function Field({ label, value, onChange, placeholder, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; rows?: number }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        rows={rows}
        placeholder={placeholder}
        className="min-h-[80px] w-full resize-y rounded-md border border-line-strong/60 bg-surface-2 px-2.5 py-2 font-mono text-[13px] leading-[20px] text-fg outline-none transition-colors placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
      />
    </label>
  );
}

/**
 * A program that never reads stdin prints the same thing for every test, so
 * the inputs cannot matter. Say so plainly, with the lines that would read them.
 */
function IgnoresInputNotice() {
  const project = useWorkspace((s) => s.project);
  const ignores = useMemo(() => !!project && !readsInput(project.language, project.files), [project]);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  if (!project || !ignores) return null;
  const example = READ_INPUT_EXAMPLE[project.language];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(example ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div role="note" aria-label="Program ignores input" className="mx-3 mt-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[13px] text-fg">
          <span className="font-medium">{basename(project.entryFile)} never reads its input</span>
          <span className="text-fg-muted">, so every test prints the same output.</span>
        </p>
        {example && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="shrink-0 rounded-md px-2 py-0.5 text-xs font-medium text-fg-muted hover:bg-hover hover:text-fg">
            {open ? "Hide" : "Show how"}
          </button>
        )}
      </div>
      {example && open && (
        <div className="relative mt-2">
          <pre className="cw-console overflow-x-auto rounded-md bg-surface-2 px-3 py-2 pr-10 font-mono text-[12.5px] leading-[19px] text-fg">{example}</pre>
          <IconButton label={copied ? "Copied" : "Copy code"} size="sm" onClick={() => void copy()} className="absolute right-1.5 top-1.5">
            {copied ? <Check className="text-success" /> : <Copy />}
          </IconButton>
        </div>
      )}
    </div>
  );
}

function TestDetail({ test, number }: { test: TestCase; number: number }) {
  const outcome = useTests((s) => s.outcomes[test.id]);
  const phase = useTests((s) => s.phase);
  const compileError = useTests((s) => s.compileError);
  const { update, remove, duplicate, run } = useTests.getState();
  const tests = useWorkspace((s) => s.project?.tests ?? EMPTY);
  const shown = shownState(test, outcome);
  const look = LOOK[shown];

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <h3 className="text-sm font-semibold text-fg">Test {number}</h3>
        {shown !== "not-run" && (
          <span className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 text-xs [&_svg]:size-3.5", look.tone, shown === "passed" ? "bg-success-soft" : shown === "failed" || shown === "crashed" || shown === "error" ? "bg-danger-soft" : shown === "time-limit" ? "bg-warning-soft" : "bg-hover")}>
            {look.icon}
            {look.label}
            {outcome?.state === "done" && shown !== "stale" && outcome.result?.executionTime !== undefined && <span className="text-fg-subtle">· {ms(outcome.result.executionTime)}</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void run([test.id])}
            disabled={phase !== "idle"}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <Play className="size-3.5 text-success" /> Run this test
          </button>
          <IconButton label="Duplicate test" size="sm" onClick={() => duplicate(test.id)} disabled={tests.length >= TEST_LIMITS.maxTests}>
            <Copy />
          </IconButton>
          <IconButton label="Delete test" size="sm" onClick={() => remove(test.id)}>
            <Trash2 />
          </IconButton>
        </div>
      </div>

      <IgnoresInputNotice />
      {/* Side by side when there is room: what goes in, what should come out, what came out. */}
      <div className="@container p-3">
        <div className="grid grid-cols-2 items-start gap-3 @[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
          <Field label="Input" value={test.input} onChange={(input) => update(test.id, { input })} placeholder="What the program reads" />
          <Field
            label="Expected output"
            value={test.expected}
            onChange={(expected) => update(test.id, { expected })}
            placeholder="What it should print (optional)"
          />
          <div className="col-span-2 min-w-0 @[900px]:col-span-1">
            {compileError && shown === "not-run" ? (
              <Block title="Compiler output" tone="danger">
                {compileError}
              </Block>
            ) : outcome?.state === "done" && outcome.result ? (
              <Result test={test} outcome={outcome} shown={shown} />
            ) : (
              <div className="hidden h-[118px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line-strong/70 text-xs text-fg-subtle @[900px]:mt-[22px] @[900px]:flex">
                {outcome ? (
                  <>
                    <Loader2 className="size-4 animate-spin text-accent" /> {outcome.state === "running" ? "Running…" : "Waiting for the tests before it"}
                  </>
                ) : (
                  "Run the test to compare its output here"
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Block({ title, tone, children, action }: { title: string; tone?: "danger" | "warning"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className={cn("text-xs font-medium", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-fg-muted")}>{title}</h4>
        {action}
      </div>
      <pre className="cw-console max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line-strong/50 bg-surface-2 px-3 py-2 font-mono text-[13px] leading-[20px] text-fg">{children}</pre>
    </section>
  );
}

function Result({ test, outcome, shown }: { test: TestCase; outcome: TestOutcome; shown: Shown }) {
  const r = outcome.result!;
  const update = useTests((s) => s.update);
  const rows = useMemo(() => diffRows(test.expected, r.stdout), [test.expected, r.stdout]);
  const useOutput = (
    <button
      type="button"
      onClick={() => update(test.id, { expected: r.stdout })}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
    >
      <Wand2 className="size-3.5" /> Use as expected output
    </button>
  );

  return (
    <div className="flex flex-col gap-3">
      {shown === "stale" && <p className="rounded-md bg-hover px-3 py-2 text-xs text-fg-subtle">The input changed since this test ran. Run it again to see the new result.</p>}

      {shown === "failed" ? (
        <DiffTable rows={rows} action={useOutput} />
      ) : (
        <Block title={shown === "passed" ? "Output matches" : "Output"} action={shown !== "passed" && r.stdout ? useOutput : undefined}>
          {r.stdout || <span className="font-sans text-fg-faint">The program printed nothing.</span>}
        </Block>
      )}

      {r.message && shown !== "passed" && <p className={cn("text-xs", shown === "time-limit" ? "text-warning" : "text-fg-subtle")}>{r.message}</p>}
      {r.stderr && (
        <Block title={shown === "crashed" ? `Error output · exit code ${r.exitCode ?? "unknown"}` : "Error output"} tone={shown === "crashed" ? "danger" : undefined}>
          {r.stderr}
        </Block>
      )}
    </div>
  );
}

/** Expected and actual output line by line, with the first difference in each line marked. */
function DiffTable({ rows, action }: { rows: ReturnType<typeof diffRows>; action: React.ReactNode }) {
  const first = rows.findIndex((r) => !r.same);
  const firstRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    firstRef.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const different = rows.filter((r) => !r.same).length;

  const cell = (text: string | null, other: string | null, same: boolean, side: "expected" | "actual") => {
    if (text === null) return <span className="font-sans text-[12px] italic text-fg-faint">{side === "expected" ? "no more lines expected" : "missing"}</span>;
    if (same || other === null) return text || " ";
    const at = firstCharDiff(text, other);
    return (
      <>
        {text.slice(0, at)}
        <mark className={cn("rounded-[2px] text-fg", side === "actual" ? "bg-danger/30" : "bg-success/25")}>{text.slice(at) || " "}</mark>
      </>
    );
  };

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-danger">
          First difference on line {first + 1}
          {different > 1 && <span className="font-normal text-fg-subtle"> · {different} lines differ</span>}
        </h4>
        {action}
      </div>
      <div className="max-h-72 overflow-auto rounded-md border border-line-strong/50 bg-surface-2">
        <table className="w-full border-collapse font-mono text-[13px] leading-[20px]">
          <thead className="sticky top-0 bg-surface-2 font-sans text-[11px] text-fg-subtle">
            <tr className="border-b border-line-strong/50">
              <th className="w-10 px-2 py-1 text-right font-normal">Line</th>
              <th className="px-3 py-1 text-left font-normal">Expected</th>
              <th className="px-3 py-1 text-left font-normal">Your output</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.line} ref={i === first ? firstRef : undefined} className={cn(!row.same && "bg-danger-soft")}>
                <td className={cn("select-none px-2 text-right align-top tabular-nums", row.same ? "text-fg-faint" : "text-danger")}>{row.line}</td>
                <td className="whitespace-pre-wrap break-all px-3 align-top text-fg-muted">{cell(row.expected, row.actual, row.same, "expected")}</td>
                <td className="whitespace-pre-wrap break-all px-3 align-top text-fg">{cell(row.actual, row.expected, row.same, "actual")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** First visit: what tests are for, with the quickest ways to make one. */
function NoTests() {
  const add = useTests((s) => s.add);
  const stdin = useWorkspace((s) => s.project?.stdin ?? "");
  const lastRun = useLastRunAsTest();

  const option = (icon: React.ReactNode, title: string, detail: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-lg border border-line-strong/60 bg-surface-2/60 px-3 py-2.5 text-left transition-colors hover:border-accent/60 hover:bg-hover"
    >
      <span className="mt-0.5 text-fg-subtle [&_svg]:size-4">{icon}</span>
      <span>
        <span className="block text-sm text-fg">{title}</span>
        <span className="block text-xs text-fg-subtle">{detail}</span>
      </span>
    </button>
  );

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-[420px] flex-col items-center gap-4 text-center">
        <div className="flex size-11 items-center justify-center rounded-xl bg-success-soft text-success">
          <FlaskConical className="size-5" />
        </div>
        <div>
          <p className="text-sm font-semibold text-fg">Check your program against test cases</p>
          <p className="mt-1 text-sm text-fg-subtle">Save inputs with the output you expect, then run them all at once.</p>
        </div>
        <div className="flex w-full flex-col gap-2">
          {option(<Plus />, "Add a test", "Type an input and the expected output", () => add())}
          {lastRun && option(<Play />, "Save the last run as a test", "Its input and output become a test you can re-check later", () => add(lastRun))}
          {!lastRun && stdin.trim() && option(<CircleDot />, "Use the Program Input", "Start from the input saved in the Program Input tab", () => add({ input: stdin }))}
        </div>
      </div>
    </div>
  );
}
