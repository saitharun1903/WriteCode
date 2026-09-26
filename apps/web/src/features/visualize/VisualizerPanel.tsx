"use client";

import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Workflow } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getLanguage, type HeapObject, type TraceFrame, type TraceStep, type TraceValue } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { runCommand } from "@/features/commands/registry";
import { showLocation } from "@/features/editor/navigate";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { stepLocation, useVisualize } from "./store";

/** Stable text for comparing a value between steps. */
function valueKey(v: TraceValue | undefined): string {
  return !v ? "" : v.kind === "value" ? `v:${v.text}` : `r:${v.id}`;
}

/** Objects in the order they are first reached from the frames, so the layout follows the code. */
function orderedObjects(step: TraceStep): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (v: TraceValue | undefined) => {
    if (v?.kind !== "ref" || seen.has(v.id) || !step.heap[v.id]) return;
    seen.add(v.id);
    order.push(v.id);
    const o = step.heap[v.id]!;
    o.items?.forEach(visit);
    o.entries?.forEach(([k, x]) => (visit(k), visit(x)));
    o.fields?.forEach(([, x]) => visit(x));
  };
  for (const f of step.frames) {
    f.locals.forEach(([, v]) => visit(v));
    visit(f.returnValue);
  }
  return order;
}

/** A value cell: inline text, or a dot an arrow starts from. */
function Cell({ value, changed }: { value: TraceValue | undefined; changed?: boolean }) {
  if (!value) return null;
  if (value.kind === "value") {
    return (
      <span
        title={value.type}
        className={cn("inline-block max-w-[16rem] truncate rounded-[3px] px-1 font-mono text-[12.5px] text-fg transition-colors", changed && "bg-warning-soft")}
      >
        {value.text}
      </span>
    );
  }
  return (
    <span
      data-ref={value.id}
      aria-label="reference"
      className={cn("inline-flex size-4 items-center justify-center rounded-[3px]", changed && "bg-warning-soft")}
    >
      <span className="size-2 rounded-full bg-accent" />
    </span>
  );
}

function FrameCard({ frame, previous, current }: { frame: TraceFrame; previous?: TraceFrame; current: boolean }) {
  const before = new Map(previous?.name === frame.name ? previous.locals.map(([n, v]) => [n, valueKey(v)]) : []);
  return (
    <div
      role="group"
      aria-label={`Frame ${frame.name}`}
      className={cn("rounded-md border bg-surface-2", current ? "border-accent shadow-[0_0_0_1px_var(--accent)]" : "border-line-strong")}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-line-strong px-2.5 py-1">
        <span className="truncate font-mono text-[13px] font-semibold text-fg">{frame.name}</span>
        <span className="shrink-0 text-xs text-fg-subtle">line {frame.line}</span>
      </div>
      <table className="w-full border-separate border-spacing-x-2 border-spacing-y-0.5 py-1">
        <tbody>
          {frame.locals.length === 0 && !frame.returnValue && (
            <tr>
              <td className="px-0.5 text-xs text-fg-subtle">No variables yet</td>
            </tr>
          )}
          {frame.locals.map(([name, value]) => (
            <tr key={name} aria-label={`${name} = ${value.kind === "value" ? value.text : "reference"}`}>
              <td className="w-0 whitespace-nowrap text-right font-mono text-[12.5px] text-fg-muted">{name}</td>
              <td>
                <Cell value={value} changed={previous !== undefined && before.get(name) !== valueKey(value)} />
              </td>
            </tr>
          ))}
          {frame.returnValue && (
            <tr aria-label={`return value = ${frame.returnValue.kind === "value" ? frame.returnValue.text : "reference"}`}>
              <td className="w-0 whitespace-nowrap text-right text-xs italic text-fg-subtle">return value</td>
              <td>
                <Cell value={frame.returnValue} changed />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ObjectCard({ id, object }: { id: string; object: HeapObject }) {
  const more = object.omitted ? <span className="px-1 text-xs text-fg-subtle">+{object.omitted} more</span> : null;
  let body: ReactNode;
  if (object.kind === "sequence") {
    body =
      object.items && object.items.length > 0 ? (
        <div className="flex flex-wrap items-stretch p-1.5">
          {object.items.map((item, i) => (
            <div key={i} className="-ml-px flex min-w-8 flex-col border border-line-strong first:ml-0">
              <span className="border-b border-line-strong px-1 text-center text-[10px] leading-4 text-fg-subtle">{i}</span>
              <span className="flex flex-1 items-center justify-center px-0.5 py-0.5">
                <Cell value={item} />
              </span>
            </div>
          ))}
          {more}
        </div>
      ) : (
        <div className="px-2 py-1.5 text-xs text-fg-subtle">empty</div>
      );
  } else if (object.kind === "map" || object.kind === "object") {
    const rows: [ReactNode, TraceValue][] =
      object.kind === "map" ? (object.entries ?? []).map(([k, v]) => [<Cell key="k" value={k} />, v]) : (object.fields ?? []).map(([n, v]) => [<span key="n" className="font-mono text-[12.5px] text-fg-muted">{n}</span>, v]);
    body =
      rows.length > 0 ? (
        <table className="border-separate border-spacing-x-2 border-spacing-y-0.5 py-1">
          <tbody>
            {rows.map(([key, value], i) => (
              <tr key={i}>
                <td className="text-right">{key}</td>
                <td>
                  <Cell value={value} />
                </td>
              </tr>
            ))}
            {more && (
              <tr>
                <td colSpan={2}>{more}</td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        <div className="px-2 py-1.5 text-xs text-fg-subtle">empty</div>
      );
  } else {
    body = <div className="px-2 py-1.5 font-mono text-[12.5px] text-fg-muted">{object.text}</div>;
  }
  return (
    <div data-object={id} role="group" aria-label={`${object.type} object`} className="w-fit max-w-full rounded-md border border-line-strong bg-surface-2">
      <div className="border-b border-line-strong px-2 py-0.5 font-mono text-[11px] text-fg-subtle">{object.type}</div>
      {body}
    </div>
  );
}

interface Arrow {
  d: string;
  key: string;
}

/** Draws an arrow from every reference dot to the object it points to. */
function useArrows(content: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    const compute = () => {
      const base = root.getBoundingClientRect();
      const next: Arrow[] = [];
      root.querySelectorAll<HTMLElement>("[data-ref]").forEach((dot, i) => {
        const target = root.querySelector<HTMLElement>(`[data-object="${CSS.escape(dot.dataset.ref!)}"]`);
        if (!target) return;
        const a = dot.getBoundingClientRect();
        const b = target.getBoundingClientRect();
        const sx = a.left + a.width / 2 - base.left;
        const sy = a.top + a.height / 2 - base.top;
        // Enter the object from the left, or from the right when it sits left of the dot.
        const toLeft = b.left - base.left >= sx;
        const tx = (toLeft ? b.left : b.right) - base.left;
        const ty = b.top - base.top + 10;
        const bend = Math.max(30, Math.abs(tx - sx) / 2);
        next.push({ key: `${i}`, d: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${toLeft ? tx - bend : tx + bend} ${ty}, ${tx} ${ty}` });
      });
      setArrows(next);
      setSize({ w: root.scrollWidth, h: root.scrollHeight });
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(root);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { arrows, size };
}

function Diagram({ step, previous }: { step: TraceStep; previous?: TraceStep }) {
  const content = useRef<HTMLDivElement>(null);
  const objects = orderedObjects(step);
  const { arrows, size } = useArrows(content, [step]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div ref={content} className="relative grid min-h-full grid-cols-[minmax(12rem,0.8fr)_minmax(14rem,1.2fr)] gap-x-16 p-3">
        <section aria-label="Frames" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Frames</h3>
          {step.frames.map((f, i) => (
            <FrameCard key={i} frame={f} previous={previous?.frames[i]} current={i === step.frames.length - 1} />
          ))}
        </section>
        <section aria-label="Objects" className="flex flex-col items-start gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Objects</h3>
          {objects.length === 0 && <p className="text-xs text-fg-subtle">No objects</p>}
          {objects.map((id) => (
            <ObjectCard key={id} id={id} object={step.heap[id]!} />
          ))}
        </section>
        <svg aria-hidden className="pointer-events-none absolute left-0 top-0" width={size.w} height={size.h}>
          <defs>
            <marker id="cw-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" />
            </marker>
          </defs>
          {arrows.map((a) => (
            <path key={a.key} d={a.d} fill="none" stroke="var(--accent)" strokeWidth="1.5" markerEnd="url(#cw-arrow)" opacity="0.85" />
          ))}
        </svg>
      </div>
    </div>
  );
}

function describeStep(step: TraceStep): string {
  const top = step.frames[step.frames.length - 1];
  if (step.event === "exception") return step.exception ?? "Exception";
  if (step.event === "return") return `${top?.name ?? ""} returns`;
  return top ? `${top.file}:${top.line}` : "";
}

/** Visualizer tool window: step through a recorded run and see its frames and objects. */
export function VisualizerPanel() {
  const trace = useVisualize((s) => s.trace);
  const stepIndex = useVisualize((s) => s.step);
  const { go, next, prev } = useVisualize.getState();
  const run = useExecution((s) => s.run);
  const language = useWorkspace((s) => (s.project ? getLanguage(s.project.language) : undefined));
  const supported = !!language?.visualizer && language.visualizer.supportLevel !== "planned";
  const recording = run?.mode === "visualize" && isRunning(run);
  // Select primitives: a fresh object per render would loop zustand's subscription.
  const file = useVisualize((s) => stepLocation(s)?.file);
  const line = useVisualize((s) => stepLocation(s)?.line);

  // Follow the current step in the editor without taking focus from the panel.
  useEffect(() => {
    if (file && line) showLocation(file, line);
  }, [file, line]);

  if (!supported) {
    return <p className="p-3 text-sm text-fg-subtle">The visualizer is available for Java and Python projects.</p>;
  }

  if (!trace || recording) {
    const failed = run?.mode === "visualize" && run.result && !trace;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-fg-subtle">
        <Workflow className="size-6 text-fg-faint" />
        {recording ? (
          <p aria-live="polite">Recording every step of the program…</p>
        ) : failed ? (
          <>
            <p className="text-fg">{run.result?.message ?? "No trace was recorded."}</p>
            <Button size="sm" onClick={() => runCommand("view.run")}>
              Show output
            </Button>
          </>
        ) : (
          <>
            <p>Step forwards and backwards through a run, with every variable and object at each line.</p>
            <Button variant="primary" size="sm" icon={<Workflow className="size-4" />} onClick={() => runCommand("run.visualize")}>
              Visualize
            </Button>
            <p className="flex items-center gap-1.5 text-xs">
              <Kbd shortcut="Mod+Alt+Enter" />
            </p>
          </>
        )}
      </div>
    );
  }

  const total = trace.steps.length;
  const step = trace.steps[stepIndex];
  if (!step) return <p className="p-3 text-sm text-fg-subtle">The program ended before its first line ran.</p>;
  const output = trace.stdout.slice(0, step.stdoutLength);

  return (
    <div
      className="flex h-full min-h-0 flex-col outline-none"
      tabIndex={0}
      aria-label="Execution visualizer"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        const actions: Record<string, () => void> = { ArrowRight: next, ArrowLeft: prev, Home: () => go(0), End: () => go(total - 1) };
        const action = actions[e.key];
        if (!action) return;
        e.preventDefault();
        action();
      }}
    >
      <div role="toolbar" aria-label="Step controls" className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label="First step" shortcut="Home" disabled={stepIndex === 0} onClick={() => go(0)}>
          <ChevronFirst />
        </IconButton>
        <IconButton label="Previous step" shortcut="Left" disabled={stepIndex === 0} onClick={prev}>
          <ChevronLeft />
        </IconButton>
        <IconButton label="Next step" shortcut="Right" disabled={stepIndex === total - 1} onClick={next}>
          <ChevronRight />
        </IconButton>
        <IconButton label="Last step" shortcut="End" disabled={stepIndex === total - 1} onClick={() => go(total - 1)}>
          <ChevronLast />
        </IconButton>
        <input
          type="range"
          aria-label="Step"
          min={0}
          max={total - 1}
          value={stepIndex}
          onChange={(e) => go(Number(e.target.value))}
          className="mx-2 w-[min(22rem,30vw)] accent-[var(--accent)]"
        />
        <span className="whitespace-nowrap text-sm tabular-nums text-fg">
          Step {stepIndex + 1} of {total}
        </span>
        <span
          className={cn(
            "ml-2 truncate text-sm",
            step.event === "exception" ? "text-danger" : step.event === "return" ? "text-success" : "text-fg-subtle",
          )}
        >
          {describeStep(step)}
        </span>
        {trace.truncated && (
          <span title={trace.truncated} className="ml-auto truncate text-xs text-warning">
            {trace.truncated}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <Diagram step={step} previous={stepIndex > 0 ? trace.steps[stepIndex - 1] : undefined} />
        <div className="flex w-[min(18rem,28%)] shrink-0 flex-col border-l border-line">
          <span className="px-3 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Output</span>
          <pre aria-label="Output so far" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[12.5px] text-fg">
            {output || <span className="font-sans text-xs text-fg-subtle">Nothing printed yet</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}
