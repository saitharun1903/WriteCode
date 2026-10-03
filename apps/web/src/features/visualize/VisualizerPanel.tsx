"use client";

import {
  ArrowLeftRight,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  CornerUpLeft,
  Equal,
  Pause,
  Play,
  Sparkles,
  Terminal,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { LANGUAGES, getLanguage, type Trace } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { ConsoleView } from "@/features/execution/OutputPanel";
import { runCommand } from "@/features/commands/registry";
import { showLocation } from "@/features/editor/navigate";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { diffSteps, timeline, type Change, type StepDiff, type Tone } from "./model";
import { BASE_STEP_MS, SPEEDS, stepLocation, useVisualize } from "./store";
import { ConceptView } from "./ConceptView";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const TONE: Record<Tone, { icon: ReactNode; color: string }> = {
  call: { icon: <CornerDownRight />, color: "var(--accent)" },
  return: { icon: <CornerUpLeft />, color: "var(--success)" },
  assign: { icon: <Equal />, color: "var(--fg-muted)" },
  mutate: { icon: <ArrowLeftRight />, color: "var(--warning)" },
  print: { icon: <Terminal />, color: "var(--viz-obj)" },
  exception: { icon: <TriangleAlert />, color: "var(--danger)" },
};

function ChangeLine({ change }: { change: Change }) {
  const tone = TONE[change.tone];
  return (
    <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className="shrink-0 [&_svg]:size-3.5" style={{ color: tone.color }}>
        {tone.icon}
      </span>
      <span className={cn("truncate", change.tone === "exception" ? "text-danger" : "text-fg")}>
        {change.parts.map((p, i) =>
          typeof p === "string" ? (
            <span key={i}>{p}</span>
          ) : (
            <code key={i} className="rounded bg-hover px-1 font-mono text-[12px]">
              {p.code}
            </code>
          ),
        )}
      </span>
    </span>
  );
}

function Narration({ trace, stepIndex, diff }: { trace: Trace; stepIndex: number; diff: StepDiff }) {
  const step = trace.steps[stepIndex]!;
  const top = step.frames[step.frames.length - 1];
  const shown = diff.changes.slice(0, 3);
  const hidden = diff.changes.length - shown.length;
  return (
    <div
      aria-live="polite"
      aria-label="What happened"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface-2/40 px-3 py-1.5 text-[12.5px]"
    >
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
          step.event === "exception" ? "bg-danger-soft text-danger" : step.event === "return" ? "bg-success-soft text-success" : "bg-accent-soft text-fg",
        )}
      >
        {step.event === "exception" ? "Exception" : step.event === "return" ? "Return" : diff.ranLine ? `Line ${diff.ranLine.line} ran` : "Start"}
      </span>
      <motion.div
        key={stepIndex}
        initial={reducedMotion() ? false : { opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden @max-[640px]/viz:order-last @max-[640px]/viz:basis-full @max-[640px]/viz:flex-col @max-[640px]/viz:items-start @max-[640px]/viz:gap-1"
      >
        {shown.length === 0 ? (
          <span className="text-fg-subtle">{stepIndex === 0 ? "The program is about to start." : "No variables changed."}</span>
        ) : (
          shown.map((c, i) => <ChangeLine key={i} change={c} />)
        )}
        {hidden > 0 && <span className="shrink-0 text-xs text-fg-subtle">+{hidden} more</span>}
      </motion.div>
      <button
        type="button"
        onClick={() => runCommand("assistant.explainStep")}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-full border border-[#8a7cf5]/60 px-2 py-0.5 text-[11.5px] text-fg hover:bg-[#8a7cf5]/15"
      >
        <Sparkles className="size-3 text-[#8a7cf5]" /> Explain this step
      </button>
      {top?.file && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle @max-[640px]/viz:hidden">
          {step.event === "line" ? "Next" : "At"}
          <span className="font-mono text-fg-muted">{`${top.file}:${top.line}`}</span>
        </span>
      )}
    </div>
  );
}

// -- Timeline

/** Scrubber showing call depth over the run, where output was printed and where exceptions happened. */
/** `from`: the first step shown (the steps before it prepare the data and are left out). */
function Timeline({ trace, from, stepIndex, onSeek }: { trace: Trace; from: number; stepIndex: number; onSeek: (step: number) => void }) {
  const t = useMemo(() => timeline(trace), [trace]);
  const n = trace.steps.length;
  const at = (i: number) => (n - from <= 1 ? 0 : (Math.max(0, i - from) / (n - 1 - from)) * 100);
  const h = t.maxDepth + 0.5;
  let area = `M 0 ${h}`;
  t.depth.forEach((d, i) => (area += ` L ${i} ${h - d} L ${i + 1} ${h - d}`));
  area += ` L ${n} ${h} Z`;
  return (
    <div className="relative mx-2 h-8 min-w-32 flex-1 @max-[640px]/viz:order-last @max-[640px]/viz:mx-1 @max-[640px]/viz:basis-full">
      <div className="absolute inset-x-0 bottom-1 top-1 overflow-hidden rounded-md bg-surface-2">
        <svg className="absolute inset-0 size-full" viewBox={`${from} 0 ${n - from} ${h}`} preserveAspectRatio="none" aria-hidden>
          <path d={area} fill="color-mix(in srgb, var(--accent) 22%, transparent)" />
        </svg>
        <div className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${at(stepIndex)}%` }} />
        {t.exceptions.filter((i) => i >= from).map((i) => (
          <span key={`e${i}`} className="absolute inset-y-0 w-0.5 bg-danger" style={{ left: `${at(i)}%` }} />
        ))}
        {t.printed.filter((i) => i >= from).map((i) => (
          <span
            key={`p${i}`}
            className="absolute bottom-0.5 size-1.5 -translate-x-1/2 rounded-full"
            style={{ left: `${at(i)}%`, background: "var(--viz-obj)" }}
          />
        ))}
      </div>
      <motion.span
        aria-hidden
        className="pointer-events-none absolute top-0 h-8 w-0.5 -translate-x-1/2 rounded-full bg-accent"
        animate={{ left: `${at(stepIndex)}%` }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
      />
      <input
        type="range"
        aria-label="Step"
        min={from}
        max={n - 1}
        value={stepIndex}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </div>
  );
}

// -- Output

function Output({ trace, stepIndex, printed }: { trace: Trace; stepIndex: number; printed: string }) {
  const box = useRef<HTMLPreElement>(null);
  const step = trace.steps[stepIndex]!;
  const text = trace.stdout.slice(0, step.stdoutLength);
  const fresh = printed && text.endsWith(printed) ? printed : "";
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  return (
    <div className="flex w-[min(19rem,28%)] shrink-0 flex-col border-l border-line @max-[640px]/viz:h-auto @max-[640px]/viz:w-full @max-[640px]/viz:border-l-0 @max-[640px]/viz:border-t">
      <span className="shrink-0 px-3 pt-3 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle @max-[640px]/viz:pt-2">Output</span>
      <pre ref={box} aria-label="Output so far" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[12.5px] text-fg @max-[640px]/viz:max-h-48 @max-[640px]/viz:min-h-10">
        {text ? (
          <>
            {text.slice(0, text.length - fresh.length)}
            {fresh && (
              <span key={stepIndex} className="cw-viz-new-output">
                {fresh}
              </span>
            )}
          </>
        ) : (
          <span className="font-sans text-xs text-fg-subtle">Nothing printed yet</span>
        )}
      </pre>
    </div>
  );
}

// -- Panel

function EmptyState({ recording, failed, message }: { recording: boolean; failed: boolean; message?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-subtle">
      <div className="relative flex size-12 items-center justify-center rounded-2xl bg-accent-soft/60">
        <Workflow className={cn("size-6 text-accent-ink", recording && "animate-pulse")} />
        {recording && <span className="absolute inset-0 animate-ping rounded-2xl border border-accent/40" />}
      </div>
      {recording ? (
        <p aria-live="polite" className="text-fg">
          Recording every step of the program…
        </p>
      ) : failed ? (
        <>
          <p className="text-fg">{message ?? "No trace was recorded."}</p>
          <Button size="sm" onClick={() => runCommand("view.run")}>
            Show output
          </Button>
        </>
      ) : (
        <>
          <p className="max-w-md text-fg">Watch your program run, one line at a time.</p>
          <Button variant="primary" size="sm" icon={<Workflow className="size-4" />} onClick={() => runCommand("run.visualize")}>
            Visualize
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * While the program is being recorded: its output so far and the input bar, so a
 * program that asks for input can be answered right here.
 */
function Recording({ waiting }: { waiting: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div aria-live="polite" className={cn("flex h-10 shrink-0 items-center gap-2.5 border-b px-3 text-sm", waiting ? "border-warning/40 bg-warning-soft/60" : "border-line")}>
        <span className="relative flex size-6 items-center justify-center rounded-lg bg-accent-soft/60">
          <Workflow className="size-3.5 animate-pulse text-accent-ink" />
        </span>
        <span className="text-fg">Recording every step of the program…</span>
        {waiting && <span className="text-warning">It is waiting for your input: type it below and press Enter.</span>}
      </div>
      <div className="min-h-0 flex-1">
        <ConsoleView />
      </div>
    </div>
  );
}

/** Visualizer tool window: play or step through a recorded run and watch its frames and objects change. */

/** The languages the visualizer records, as a sentence reads them. */
const withVisualizer = sentence(LANGUAGES.filter((l) => l.visualizer).map((l) => l.name));

function sentence(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}
export function VisualizerPanel() {
  const trace = useVisualize((s) => s.trace);
  const stepIndex = useVisualize((s) => s.step);
  const playing = useVisualize((s) => s.playing);
  const speed = useVisualize((s) => s.speed);
  const start = useVisualize((s) => s.start);
  const showSetup = useVisualize((s) => s.showSetup);
  // The steps that only prepare the data are left out until asked for.
  const from = showSetup ? 0 : start;
  const { go, next, prev, togglePlay, pause, setSpeed, setShowSetup } = useVisualize.getState();
  const run = useExecution((s) => s.run);
  const language = useWorkspace((s) => (s.project ? getLanguage(s.project.language) : undefined));
  const supported = !!language?.visualizer && language.visualizer.supportLevel !== "planned";
  const recording = run?.mode === "visualize" && isRunning(run);
  // Select primitives: a fresh object per render would loop zustand's subscription.
  const file = useVisualize((s) => stepLocation(s)?.file);
  const line = useVisualize((s) => stepLocation(s)?.line);
  const total = trace?.steps.length ?? 0;
  const diff = useMemo(() => (trace && stepIndex < trace.steps.length ? diffSteps(trace, stepIndex) : null), [trace, stepIndex]);

  // Follow the current step in the editor without taking focus from the panel.
  useEffect(() => {
    if (file && line) showLocation(file, line);
  }, [file, line]);

  useEffect(() => {
    if (!playing) return;
    if (stepIndex >= total - 1) return pause();
    const timer = setTimeout(next, BASE_STEP_MS / speed);
    return () => clearTimeout(timer);
  }, [playing, stepIndex, speed, total, next, pause]);

  if (!supported) {
    return <p className="p-3 text-sm text-fg-subtle">The visualizer is available for {withVisualizer} projects.</p>;
  }
  if (recording) return <Recording waiting={run?.status === "WAITING_FOR_INPUT"} />;
  if (!trace) {
    const failed = run?.mode === "visualize" && !!run.result && !trace;
    return <EmptyState recording={recording} failed={failed} message={run?.result?.message} />;
  }

  const step = trace.steps[stepIndex];
  if (!step || !diff) return <p className="p-3 text-sm text-fg-subtle">The program ended before its first line ran.</p>;
  const manual = (action: () => void) => () => {
    pause();
    action();
  };

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="@container/viz flex h-full min-h-0 flex-col outline-none"
        tabIndex={0}
        aria-label="Execution visualizer"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement && e.key !== " ") return;
          const actions: Record<string, () => void> = {
            ArrowRight: manual(next),
            ArrowLeft: manual(prev),
            Home: manual(() => go(from)),
            End: manual(() => go(total - 1)),
            " ": togglePlay,
          };
          const action = actions[e.key];
          if (!action) return;
          e.preventDefault();
          action();
        }}
      >
        <div role="toolbar" aria-label="Step controls" className="flex min-h-11 shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-2 @max-[640px]/viz:gap-y-1 @max-[640px]/viz:py-1.5">
          <IconButton label="First step" shortcut="Home" disabled={stepIndex <= from} onClick={manual(() => go(from))}>
            <ChevronFirst />
          </IconButton>
          <IconButton label="Previous step" shortcut="Left" disabled={stepIndex <= from} onClick={manual(prev)}>
            <ChevronLeft />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={togglePlay}
            className="mx-1 flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg transition-transform hover:scale-105 active:scale-95 [&_svg]:size-4"
          >
            {playing ? <Pause /> : <Play className="translate-x-px" />}
          </button>
          <IconButton label="Next step" shortcut="Right" disabled={stepIndex === total - 1} onClick={manual(next)}>
            <ChevronRight />
          </IconButton>
          <IconButton label="Last step" shortcut="End" disabled={stepIndex === total - 1} onClick={manual(() => go(total - 1))}>
            <ChevronLast />
          </IconButton>
          <Timeline trace={trace} from={from} stepIndex={stepIndex} onSeek={(i) => (pause(), go(i))} />
          <span className="whitespace-nowrap text-sm tabular-nums text-fg">{`Step ${stepIndex - from + 1} of ${total - from}`}</span>
          <div role="group" aria-label="Playback speed" className="ml-2 flex rounded-md border border-line-strong p-0.5">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={speed === s}
                onClick={() => setSpeed(s)}
                className={cn("rounded px-1.5 text-xs tabular-nums leading-5", speed === s ? "bg-accent text-accent-fg" : "text-fg-subtle hover:text-fg")}
              >
                {s}×
              </button>
            ))}
          </div>
          {start > 0 && (
            <button
              type="button"
              aria-pressed={showSetup}
              title={showSetup ? "Start again from where the program's logic begins" : `The first ${start} steps only prepare the data (variables, arrays, nodes). Show them too.`}
              onClick={() => setShowSetup(!showSetup)}
              className={cn("ml-2 rounded-md border px-2 text-xs leading-[22px]", showSetup ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-subtle hover:text-fg")}
            >
              Setup steps
            </button>
          )}
          {trace.truncated && (
            <span title={trace.truncated} className="ml-2 flex min-w-0 max-w-48 items-center gap-1 text-xs text-warning [&_svg]:size-3.5 [&_svg]:shrink-0">
              <TriangleAlert />
              <span className="truncate">{trace.truncated}</span>
            </span>
          )}
        </div>
        {/* On a narrow panel (a phone) all of this is one column that scrolls, so each part keeps its full height. */}
        <div className="flex min-h-0 flex-1 flex-col @max-[640px]/viz:overflow-y-auto">
          <Narration trace={trace} stepIndex={stepIndex} diff={diff} />
          <div className="flex min-h-0 flex-1 @max-[640px]/viz:flex-none @max-[640px]/viz:flex-col">
            <LayoutGroup>
              <ConceptView trace={trace} stepIndex={stepIndex} diff={diff} />
            </LayoutGroup>
            <Output trace={trace} stepIndex={stepIndex} printed={diff.printed} />
          </div>
        </div>
      </div>
    </MotionConfig>
  );
}
