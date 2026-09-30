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
  SquareFunction,
  Terminal,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { getLanguage, type HeapObject, type Trace, type TraceFrame, type TraceStep, type TraceValue } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { runCommand } from "@/features/commands/registry";
import { showLocation } from "@/features/editor/navigate";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { diffSteps, frameIds, indexPointers, isCallable, layoutHeap, nameOf, timeline, valueKey, type Change, type StepDiff, type Tone } from "./model";
import { BASE_STEP_MS, SPEEDS, stepLocation, useVisualize } from "./store";
import { ConceptView, hasStructures } from "./ConceptView";

const SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.8,
} as const;

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// -- Values

const NUMBER_TYPES = /^(int|float|complex|long|double|short|byte|Integer|Long|Double|Float|Short|Byte|BigInteger|BigDecimal|number|bigint)$/;
const STRING_TYPES = /^(str|String|char|Character|bytes|string)$/;
const KEYWORDS = new Set(["None", "null", "True", "False", "true", "false", "undefined"]);

function valueColor(v: { text: string; type: string }): string {
  if (KEYWORDS.has(v.text) || v.type === "NoneType" || v.type === "null") return "var(--viz-kw)";
  if (NUMBER_TYPES.test(v.type)) return "var(--viz-num)";
  if (STRING_TYPES.test(v.type)) return "var(--viz-str)";
  return "var(--fg)";
}

/** Plain-text form of a value for accessible labels. */
function label(step: TraceStep, v: TraceValue, showCallables: boolean): string {
  if (v.kind === "value") return v.text;
  const o = step.heap[v.id];
  return !showCallables && isCallable(o) ? `${o!.type} ${o!.text ?? ""}`.trim() : "reference";
}

interface ValProps {
  step: TraceStep;
  value: TraceValue | undefined;
  /** Stable key of the slot, used by arrows (`var:0:nums`, `cell:<id>:2`...). */
  src: string;
  changed: boolean;
  stepIndex: number;
  showCallables: boolean;
  /** Drawn as a box, the way a variable holds its value. */
  boxed?: boolean;
  /** The value before this step, shown struck through beside a changed value. */
  before?: string;
}

/** A value slot: inline text, a function chip, or a dot an arrow starts from. Changed values flash. */
function Val({ step, value, src, changed, stepIndex, showCallables, boxed, before }: ValProps) {
  if (!value) return null;
  const pop = changed && !reducedMotion() ? { scale: 1.35, y: -4 } : false;
  const was =
    changed && before !== undefined && before !== "" ? (
      <motion.span
        key={`w${stepIndex}`}
        initial={reducedMotion() ? false : { opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        title="Value before this step"
        className="ml-2 inline-block max-w-[9rem] truncate align-middle text-[11px] text-fg-subtle"
      >
        was <span className="font-mono">{before}</span>
      </motion.span>
    ) : null;
  if (value.kind === "value") {
    return (
      <>
        <motion.span
          key={changed ? `c${stepIndex}` : "s"}
          initial={pop}
          animate={{ scale: 1, y: 0 }}
          transition={SPRING}
          title={value.type}
          style={{ color: valueColor(value) }}
          className={cn(
            "inline-block max-w-[16rem] truncate rounded-[4px] px-1 align-middle font-mono text-[12.5px] leading-5",
            boxed && "min-w-8 border border-line-strong bg-surface px-1.5 text-center leading-6",
            changed && "cw-viz-changed",
          )}
        >
          {value.text}
        </motion.span>
        {was}
      </>
    );
  }
  const o = step.heap[value.id];
  if (!showCallables && isCallable(o)) {
    return (
      <span
        className="inline-flex max-w-[16rem] items-center gap-1 truncate rounded-[4px] bg-hover px-1.5 font-mono text-[12px] leading-5 text-fg-muted"
        title={o!.text}
      >
        <span className="italic" style={{ color: "var(--viz-kw)" }}>
          {o!.type === "class" ? "class" : "ƒ"}
        </span>
        {(o!.text ?? "").replace(/^(class|bound method) /, "")}
      </span>
    );
  }
  const dot = (
    <span data-ref={value.id} data-src={src} aria-label="reference" className="inline-flex size-5 items-center justify-center">
      <motion.span
        key={changed ? `c${stepIndex}` : "s"}
        initial={changed && !reducedMotion() ? { scale: 2.2 } : false}
        animate={{ scale: 1 }}
        transition={SPRING}
        className="size-2.5 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_25%,transparent)]"
      />
    </span>
  );
  if (!boxed) return dot;
  // A reference is a box too: what it holds is an arrow to the object, not the object.
  return (
    <span
      title={`Refers to ${o?.type ?? "an object"} (follow the arrow)`}
      className={cn(
        "inline-flex h-6 min-w-8 items-center justify-center rounded-[4px] border border-line-strong bg-surface align-middle",
        changed && "cw-viz-changed",
      )}
    >
      {dot}
    </span>
  );
}

// -- Frames

/** `search` → `search()`; Python's top level reads as the global variables it holds. */
function frameLabel(name: string): string {
  return name === "<module>" ? "Global variables" : `${name}()`;
}

/** The name a call is known by in the source: `Candies.search` → `search`. */
function shortName(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/** Marks something that did not exist before this step. */
function NewTag({ stepIndex }: { stepIndex: number }) {
  return (
    <motion.span
      key={stepIndex}
      initial={reducedMotion() ? false : { opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={SPRING}
      className="ml-1.5 rounded-full bg-success-soft px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-success"
    >
      new
    </motion.span>
  );
}

function FrameCard({
  frame,
  index,
  step,
  diff,
  current,
  stepIndex,
  showCallables,
  callee,
  hide,
}: {
  frame: TraceFrame;
  index: number;
  step: TraceStep;
  diff: StepDiff;
  current: boolean;
  stepIndex: number;
  showCallables: boolean;
  /** The call this frame is waiting on (the next frame down), if any. */
  callee?: string;
  /** Variables not worth drawing (Java's empty `args`). */
  hide: (name: string, value: TraceValue) => boolean;
}) {
  // The top level "returns None" when the program ends; that is not the program's data.
  const returnValue = frame.name === "<module>" ? undefined : frame.returnValue;
  const locals = frame.locals.filter(([n, v]) => !hide(n, v));
  const returning = current && step.event === "return";
  const status = returning ? "Returning" : current ? "Running" : callee ? `Waiting for ${callee}()` : "Waiting";
  return (
    <div
      data-card
      data-current-frame={current || undefined}
      role="group"
      aria-label={`Frame ${frame.name}`}
      className={cn(
        "rounded-lg border bg-surface-2 transition-[border-color,box-shadow,opacity] duration-300",
        current ? "border-accent shadow-[0_0_0_1px_var(--accent),0_10px_30px_-14px_var(--accent)]" : "border-line-strong opacity-75",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line-strong px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {current && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
          <span className="truncate font-mono text-[13px] font-semibold text-fg" title={frame.name}>
            {frameLabel(frame.name)}
          </span>
        </span>
        <span
          title={current ? `This call is running line ${frame.line} next` : `Paused on line ${frame.line} until ${callee ?? "the call below"} returns`}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] tabular-nums",
            returning ? "bg-success-soft text-success" : current ? "bg-accent-soft text-fg" : "bg-hover text-fg-subtle",
          )}
        >
          {status} · line {frame.line}
        </span>
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2.5 gap-y-1.5 px-3 py-2">
        {locals.length === 0 && !returnValue && <span className="col-span-2 text-xs text-fg-subtle">No variables yet</span>}
        {locals.map(([name, value]) => {
          const src = `var:${index}:${name}`;
          const isNew = diff.highlights.has(src) && !diff.before.has(src) && !diff.newFrames.has(index);
          return (
            <div key={name} role="row" aria-label={`${name} = ${label(step, value, showCallables)}`} data-hover={`src:${src}`} className="contents">
              <span className="text-right font-mono text-[12.5px] text-fg-muted">{name}</span>
              <span className="flex min-w-0 items-center">
                <Val
                  step={step}
                  value={value}
                  src={src}
                  changed={diff.highlights.has(src)}
                  before={diff.before.get(src)}
                  stepIndex={stepIndex}
                  showCallables={showCallables}
                  boxed={value.kind === "ref" ? !isCallable(step.heap[value.id]) || showCallables : true}
                />
                {isNew && <NewTag stepIndex={stepIndex} />}
              </span>
            </div>
          );
        })}
        {returnValue && (
          <motion.div
            role="row"
            aria-label={`return value = ${label(step, returnValue, showCallables)}`}
            initial={reducedMotion() ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING}
            className="col-span-2 mt-1 flex items-center gap-2 rounded-md bg-success-soft px-2 py-1"
          >
            <CornerUpLeft className="size-3.5 text-success" />
            <span className="text-xs text-success">return value</span>
            <Val step={step} value={returnValue} src={`ret:${index}`} changed stepIndex={stepIndex} showCallables={showCallables} />
          </motion.div>
        )}
      </div>
    </div>
  );
}

// -- Objects

const KIND_COLOR: Record<HeapObject["kind"], string> = {
  sequence: "var(--viz-seq)",
  map: "var(--viz-map)",
  object: "var(--viz-obj)",
  other: "var(--fg-faint)",
};

function sizeOf(o: HeapObject): string | null {
  const n = (o.kind === "sequence" ? (o.items?.length ?? 0) : o.kind === "map" ? (o.entries?.length ?? 0) : -1) + (o.omitted ?? 0);
  if (n < 0) return null;
  const unit = o.kind === "sequence" ? "item" : "entry";
  return n === 0 ? "empty" : `${n} ${n === 1 ? unit : unit === "entry" ? "entries" : "items"}`;
}

/** A variable holding a reference to an object. */
interface Holder {
  name: string;
  frame: string;
  current: boolean;
}

/** Who points at each object directly from a variable, outermost call first. */
function holdersOf(step: TraceStep, hide: (name: string, value: TraceValue) => boolean): Map<string, Holder[]> {
  const out = new Map<string, Holder[]>();
  step.frames.forEach((f, i) => {
    for (const [name, v] of f.locals) {
      if (v.kind !== "ref" || hide(name, v)) continue;
      const list = out.get(v.id) ?? [];
      list.push({
        name,
        frame: shortName(f.name),
        current: i === step.frames.length - 1,
      });
      out.set(v.id, list);
    }
  });
  return out;
}

/** Plain words for what kind of thing an object is. */
function kindWord(o: HeapObject): string {
  return o.kind === "sequence" ? "array" : o.kind === "map" ? "map" : "object";
}

/** "arr in main", and a note when several calls share one object. */
function Holders({ holders, object, fallback }: { holders: Holder[]; object: HeapObject; fallback: string | null }) {
  if (holders.length === 0) {
    return fallback ? <span className="truncate font-mono text-[11px] text-fg-subtle">via {fallback}</span> : null;
  }
  const frames = [...new Set(holders.map((h) => h.frame))];
  const shared = frames.length > 1;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-1"
      title={
        shared
          ? `The same ${kindWord(object)}: ${holders.map((h) => `${h.name} in ${h.frame}()`).join(" and ")} point to it, so a change through one is seen by all.`
          : undefined
      }
    >
      {holders.map((h, i) => (
        <span key={i} className={cn("rounded px-1 font-mono text-[11px] leading-4", h.current ? "bg-accent-soft text-fg" : "bg-hover text-fg-subtle")}>
          {h.name}
          {shared && <span className="text-fg-muted"> in {h.frame}</span>}
        </span>
      ))}
      {shared && <span className="text-[11px] text-fg-subtle">same {kindWord(object)}</span>}
    </span>
  );
}

function ObjectCard({
  id,
  object,
  step,
  diff,
  stepIndex,
  pointers,
  emphasized,
  showCallables,
  holders,
}: {
  id: string;
  object: HeapObject;
  step: TraceStep;
  diff: StepDiff;
  stepIndex: number;
  pointers: Map<number, string[]> | undefined;
  emphasized: boolean;
  showCallables: boolean;
  holders: Holder[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const swap = diff.swaps.get(id);
  const common = { step, stepIndex, showCallables };
  const more = object.omitted ? <span className="self-center px-1 text-xs text-fg-subtle">+{object.omitted} more</span> : null;
  const size = sizeOf(object);

  // Swapped elements travel to each other's slot along an arc.
  useLayoutEffect(() => {
    if (!swap || !ref.current || reducedMotion()) return;
    const cell = (i: number) => ref.current!.querySelector<HTMLElement>(`[data-cell="${i}"]`);
    const a = cell(swap[0]);
    const b = cell(swap[1]);
    if (!a || !b) return;
    const dx = b.getBoundingClientRect().left - a.getBoundingClientRect().left;
    const opts: KeyframeAnimationOptions = {
      duration: 800,
      easing: "cubic-bezier(.3,.7,.25,1)",
    };
    const animations = [
      a.animate([{ transform: `translate(${dx}px,0)` }, { transform: `translate(${dx / 2}px,-34px)`, offset: 0.5 }, { transform: "none" }], opts),
      b.animate([{ transform: `translate(${-dx}px,0)` }, { transform: `translate(${-dx / 2}px,34px)`, offset: 0.5 }, { transform: "none" }], opts),
    ];
    return () => animations.forEach((x) => x.cancel());
  }, [swap, stepIndex]);

  let body: ReactNode;
  if (object.kind === "sequence") {
    const items = object.items ?? [];
    body =
      items.length > 0 ? (
        <div className="flex max-w-[44rem] flex-wrap items-start px-2 pb-1.5 pt-1">
          {items.map((item, i) => {
            const names = pointers?.get(i) ?? [];
            const changed = diff.highlights.has(`cell:${id}:${i}`);
            return (
              <div key={i} className="flex flex-col items-center">
                <span className="text-[10px] leading-4 tabular-nums text-fg-subtle">{i}</span>
                <div
                  className={cn(
                    "relative -ml-px flex h-9 min-w-10 items-center justify-center border border-line-strong bg-surface px-1 transition-colors duration-300",
                    i === 0 && "ml-0 rounded-l-md",
                    i === items.length - 1 && !more && "rounded-r-md",
                    names.length > 0 && "border-accent/60 bg-accent-soft/40",
                  )}
                >
                  <span data-cell={i} className="inline-flex">
                    <Val {...common} value={item} src={`cell:${id}:${i}`} changed={changed} />
                  </span>
                  {changed && diff.before.has(`cell:${id}:${i}`) && !diff.swaps.has(id) && (
                    <motion.span
                      key={stepIndex}
                      initial={reducedMotion() ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      title="Value before this step"
                      className="absolute -top-2 right-0 max-w-12 truncate rounded bg-surface-2 px-0.5 text-[9.5px] leading-3 text-fg-subtle"
                    >
                      was {diff.before.get(`cell:${id}:${i}`)}
                    </motion.span>
                  )}
                </div>
                {pointers && (
                  <div className="flex h-5 flex-col items-center">
                    {names.map((n) => (
                      <motion.span
                        key={n}
                        layoutId={`ptr:${id}:${n}`}
                        transition={SPRING}
                        className="mt-0.5 rounded-full bg-accent px-1.5 font-mono text-[10.5px] font-semibold leading-4 text-accent-fg"
                      >
                        {n}
                      </motion.span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {more}
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-fg-subtle">empty</div>
      );
  } else if (object.kind === "map" || object.kind === "object") {
    const rows: [ReactNode, TraceValue, string][] =
      object.kind === "map"
        ? (object.entries ?? []).map(([k, v], i) => [
            <Val key="k" {...common} value={k} src={`mapkey:${id}:${i}`} changed={false} />,
            v,
            `key:${id}:${valueKey(k)}`,
          ])
        : (object.fields ?? []).map(([n, v]) => [
            <span key="n" className="font-mono text-[12.5px] text-fg-muted">
              {n}
            </span>,
            v,
            `field:${id}:${n}`,
          ]);
    body =
      rows.length > 0 ? (
        <div className="grid grid-cols-[auto_auto] items-center gap-x-2.5 gap-y-1 px-3 py-2">
          {rows.map(([key, value, hl], i) => (
            <div key={i} className="contents" data-hover={`src:${hl}`}>
              <span className="text-right">{key}</span>
              <span>
                <Val {...common} value={value} src={hl} changed={diff.highlights.has(hl)} before={diff.before.get(hl)} />
              </span>
            </div>
          ))}
          {more && <span className="col-span-2">{more}</span>}
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-fg-subtle">empty</div>
      );
  } else {
    body = <div className="px-3 py-2 font-mono text-[12.5px] text-fg-muted">{object.text}</div>;
  }

  return (
    <div
      ref={ref}
      data-card
      data-object={id}
      data-hover={`obj:${id}`}
      role="group"
      aria-label={`${object.type} object`}
      style={{ borderTopColor: KIND_COLOR[object.kind] }}
      className={cn(
        "w-fit max-w-full rounded-lg border border-t-2 border-line-strong bg-surface-2 shadow-sm transition-shadow duration-200",
        emphasized && "shadow-[0_0_0_2px_var(--accent),0_10px_30px_-12px_var(--accent)]",
      )}
    >
      <div className="flex max-w-[44rem] items-center gap-2 px-3 pt-1.5">
        <span className="shrink-0 font-mono text-[11px]">
          <span style={{ color: KIND_COLOR[object.kind] }} className="font-semibold">
            {object.type}
          </span>
          {size !== null && <span className="text-fg-subtle"> · {size}</span>}
        </span>
        <Holders holders={holders} object={object} fallback={holders.length === 0 ? nameOf(step, id) : null} />
        {diff.highlights.has(`obj:${id}`) && <NewTag stepIndex={stepIndex} />}
      </div>
      {body}
    </div>
  );
}

// -- Arrows

interface Arrow {
  key: string;
  d: string;
  src: string;
  target: string;
}

/**
 * Draws an arrow from every reference dot to its object. Recomputed on every
 * animation frame while cards move after a step, so arrows follow them.
 */
function Arrows({
  root,
  trigger,
  hover,
  currentFrame,
}: {
  root: RefObject<HTMLDivElement | null>;
  trigger: unknown;
  hover: string | null;
  currentFrame: number;
}) {
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    let last = "";
    const compute = () => {
      const base = el.getBoundingClientRect();
      const next: Arrow[] = [];
      el.querySelectorAll<HTMLElement>("[data-ref]").forEach((dot) => {
        const id = dot.dataset.ref!;
        const target = el.querySelector<HTMLElement>(`[data-object="${CSS.escape(id)}"]`);
        if (!target) return;
        const a = dot.getBoundingClientRect();
        const b = target.getBoundingClientRect();
        const dx = a.left + a.width / 2 - base.left;
        const sy = a.top + a.height / 2 - base.top;
        // Leave the dot's card horizontally first, so arrows never cut across other rows.
        const card = dot.closest<HTMLElement>("[data-card]");
        const sx = Math.max(dx, card ? card.getBoundingClientRect().right - base.left + 8 : dx);
        const lead = sx > dx ? `M ${dx} ${sy} L ${sx} ${sy} ` : `M ${sx} ${sy} `;
        const left = b.left - base.left;
        const top = b.top - base.top;
        let d: string;
        if (left >= sx + 12) {
          // Ahead of the dot: enter the card's left edge beside its title.
          const ty = top + 13;
          const bend = Math.max(28, (left - sx) / 2);
          d = `${lead}C ${sx + bend} ${sy}, ${left - bend} ${ty}, ${left - 1} ${ty}`;
        } else {
          // Behind or around the dot (cycles, back references): come down onto the card's top.
          const tx = left + Math.min(28, b.width / 2);
          const lift = Math.max(40, Math.abs(sy - top) / 2);
          d = `${lead}C ${sx + 60} ${sy - lift}, ${tx} ${top - lift}, ${tx} ${top - 1}`;
        }
        next.push({
          key: `${dot.dataset.src}->${id}`,
          d,
          src: dot.dataset.src ?? "",
          target: id,
        });
      });
      const sig = next.map((x) => x.key + x.d).join("|");
      if (sig !== last) {
        last = sig;
        setArrows(next);
        setSize({ w: el.scrollWidth, h: el.scrollHeight });
      }
    };
    let raf = 0;
    const until = performance.now() + 1100;
    const loop = () => {
      compute();
      if (performance.now() < until) raf = requestAnimationFrame(loop);
    };
    loop();
    const observer = new ResizeObserver(compute);
    observer.observe(el);
    // The objects column stays in place while the calls scroll: arrows follow.
    const scroller = el.parentElement;
    scroller?.addEventListener("scroll", compute, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scroller?.removeEventListener("scroll", compute);
    };
  }, [root, trigger]);

  const focused = (a: Arrow) => hover === `src:${a.src}` || hover === `obj:${a.target}`;
  // Variables of calls that are waiting point too, but more quietly than the running call's.
  const waiting = (a: Arrow) => {
    const m = /^var:(\d+):/.exec(a.src);
    return !!m && Number(m[1]) !== currentFrame && !focused(a);
  };
  return (
    <svg aria-hidden className="pointer-events-none absolute left-0 top-0 overflow-visible" width={size.w} height={size.h}>
      <defs>
        <marker id="cw-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
        </marker>
        <marker id="cw-arrow-quiet" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--fg-faint)" />
        </marker>
      </defs>
      {arrows.map((a) => (
        <motion.path
          key={a.key}
          d={a.d}
          fill="none"
          stroke={waiting(a) ? "var(--fg-faint)" : "var(--accent)"}
          strokeDasharray={waiting(a) ? "4 4" : undefined}
          strokeLinecap="round"
          markerEnd={waiting(a) ? "url(#cw-arrow-quiet)" : "url(#cw-arrow)"}
          initial={reducedMotion() ? false : { pathLength: 0, opacity: 0 }}
          animate={{
            pathLength: 1,
            opacity: hover ? (focused(a) ? 1 : 0.2) : 0.8,
            strokeWidth: focused(a) ? 2.5 : 1.6,
          }}
          transition={{
            pathLength: { duration: 0.55, ease: "easeOut" },
            opacity: { duration: 0.2 },
          }}
        />
      ))}
    </svg>
  );
}

// -- Diagram

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div>
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{title}</h3>
      {hint && <p className="mt-0.5 max-w-[34rem] text-[11.5px] leading-4 text-fg-faint">{hint}</p>}
    </div>
  );
}

const LEGEND_KEY = "cw.visualize.legend";

/** Whether the how-to-read line is shown; remembered per browser once hidden. */
function useLegend(): [boolean, (show: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      return localStorage.getItem(LEGEND_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  const set = (show: boolean) => {
    setShown(show);
    try {
      if (show) localStorage.removeItem(LEGEND_KEY);
      else localStorage.setItem(LEGEND_KEY, "hidden");
    } catch {}
  };
  return [shown, set];
}

/** How to read the drawing, in one line. */
function Legend({ onHide }: { onHide: () => void }) {
  const item = "flex items-center gap-1.5 whitespace-nowrap";
  const box = "inline-flex h-5 min-w-7 items-center justify-center rounded-[4px] border border-line-strong bg-surface px-1 font-mono text-[11px]";
  return (
    <div
      role="note"
      aria-label="How to read this view"
      className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-line bg-surface-2/40 px-4 py-2 text-[11.5px] text-fg-subtle"
    >
      <span className={item}>
        <span className={box} style={{ color: "var(--viz-num)" }}>
          5
        </span>
        value kept in the variable
      </span>
      <span className={item}>
        <span className={box}>
          <span className="size-2 rounded-full bg-accent" />
        </span>
        <svg width="22" height="8" aria-hidden className="-ml-1">
          <path d="M0 4 H17" stroke="var(--accent)" strokeWidth="1.6" />
          <path d="M16 0.5 L21 4 L16 7.5 z" fill="var(--accent)" />
        </svg>
        points to an object
      </span>
      <span className={item}>
        <svg width="22" height="8" aria-hidden>
          <path d="M0 4 H22" stroke="var(--fg-faint)" strokeWidth="1.6" strokeDasharray="4 4" />
        </svg>
        from a waiting call
      </span>
      <span className={item}>
        <span className={cn(box, "cw-viz-changed")} style={{ color: "var(--viz-num)" }}>
          7
        </span>
        <span className="text-[11px]">
          was <span className="font-mono">3</span>
        </span>
        changed in this step
      </span>
      <span className={item}>
        <span className="rounded-full bg-accent px-1.5 font-mono text-[10px] font-semibold leading-4 text-accent-fg">i</span>
        index into the array
      </span>
      <button type="button" onClick={onHide} className="ml-auto rounded px-1.5 text-[11px] text-fg-subtle hover:bg-hover hover:text-fg">
        Hide guide
      </button>
    </div>
  );
}

function Diagram({ trace, stepIndex, diff, ids, showCallables }: { trace: Trace; stepIndex: number; diff: StepDiff; ids: string[]; showCallables: boolean }) {
  const content = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [guide, setGuide] = useLegend();
  const step = trace.steps[stepIndex]!;
  // Java's `main(String[] args)` gets no arguments here: an empty `args` is only noise.
  const hideLocal = (name: string, v: TraceValue) => {
    if (name !== "args" || v.kind !== "ref") return false;
    const o = step.heap[v.id];
    return o?.kind === "sequence" && o.type === "String[]" && (o.items?.length ?? 0) === 0;
  };
  const noise = new Set(step.frames.flatMap((f) => f.locals.flatMap(([n, v]) => (v.kind === "ref" && hideLocal(n, v) ? [v.id] : []))));
  const hidden = (id: string) => noise.has(id) || (!showCallables && isCallable(step.heap[id]));
  const placements = layoutHeap(step, hidden);
  const holders = holdersOf(step, hideLocal);
  const currentFrame = step.frames.length - 1;
  const pointers = indexPointers(step);
  const columns = Math.max(1, ...placements.map((p) => p.col + 1));

  // Keep the running frame in view (deep recursion pushes it below the fold).
  // Scrolls only this diagram, never the page.
  useEffect(() => {
    const box = content.current?.parentElement;
    const frame = content.current?.querySelector<HTMLElement>("[data-current-frame]");
    if (!box || !frame) return;
    const timer = setTimeout(() => {
      const b = box.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      const margin = 12;
      let top = box.scrollTop;
      if (f.bottom > b.bottom - margin) top += f.bottom - b.bottom + margin;
      if (f.top < b.top + margin) top -= b.top + margin - f.top;
      if (top !== box.scrollTop) box.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
    }, 60);
    return () => clearTimeout(timer);
  }, [stepIndex]);

  // While the objects fit the panel they stay in view as the calls scroll past.
  const objects = useRef<HTMLElement>(null);
  const [pinned, setPinned] = useState(true);
  useLayoutEffect(() => {
    const box = content.current?.parentElement;
    const el = objects.current;
    if (!box || !el) return;
    const check = () => setPinned(el.offsetHeight <= box.clientHeight - 16);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {guide && <Legend onHide={() => setGuide(false)} />}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {!guide && (
          <button
            type="button"
            onClick={() => setGuide(true)}
            className="absolute right-3 top-3 z-10 rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[11px] text-fg-subtle hover:text-fg"
          >
            How to read this
          </button>
        )}
        <div
          ref={content}
          className="relative grid min-h-full grid-cols-[minmax(13rem,0.7fr)_minmax(16rem,1.3fr)] content-start gap-x-20 p-4"
          onPointerOver={(e) => setHover((e.target as HTMLElement).closest<HTMLElement>("[data-hover]")?.dataset.hover ?? null)}
          onPointerLeave={() => setHover(null)}
        >
          <section aria-label="Frames" className="flex flex-col gap-2.5">
            <SectionTitle
              title="Function calls"
              hint={guide ? "Each call keeps its own variables. The newest call is at the bottom; the calls above it wait until it returns." : undefined}
            />
            <AnimatePresence initial={false} mode="popLayout">
              {step.frames.map((f, i) => (
                <motion.div
                  key={ids[i] ?? i}
                  layout="position"
                  initial={reducedMotion() ? false : { opacity: 0, x: -30, scale: 0.94 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{
                    opacity: 0,
                    x: -30,
                    scale: 0.94,
                    transition: { duration: 0.2 },
                  }}
                  transition={SPRING}
                >
                  <FrameCard
                    frame={f}
                    index={i}
                    step={step}
                    diff={diff}
                    current={i === currentFrame}
                    stepIndex={stepIndex}
                    showCallables={showCallables}
                    callee={i < currentFrame ? shortName(step.frames[i + 1]!.name) : undefined}
                    hide={hideLocal}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </section>
          <section ref={objects} aria-label="Objects" className={cn("flex min-w-0 flex-col gap-2.5 self-start", pinned && "sticky top-3")}>
            <SectionTitle
              title="Objects in memory"
              hint={guide ? "Arrays, lists, maps and objects live here. A variable does not contain them, it points to them: follow the arrow." : undefined}
            />
            {placements.length === 0 && <p className="text-xs text-fg-subtle">No arrays or objects yet. Numbers and text stay inside their variable.</p>}
            <div className="grid items-start gap-x-14 gap-y-5" style={{ gridTemplateColumns: `repeat(${columns}, max-content)` }}>
              <AnimatePresence initial={false} mode="popLayout">
                {placements.map((p) => (
                  <motion.div
                    key={p.id}
                    layout="position"
                    style={{ gridRow: p.row + 1, gridColumn: p.col + 1 }}
                    initial={reducedMotion() ? false : { opacity: 0, scale: 0.8, y: 10 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{
                      opacity: 0,
                      scale: 0.8,
                      transition: { duration: 0.2 },
                    }}
                    transition={SPRING}
                  >
                    <ObjectCard
                      id={p.id}
                      object={step.heap[p.id]!}
                      step={step}
                      diff={diff}
                      stepIndex={stepIndex}
                      pointers={pointers.get(p.id)}
                      emphasized={hover === `obj:${p.id}`}
                      showCallables={showCallables}
                      holders={holders.get(p.id) ?? []}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>
          <Arrows root={content} trigger={`${stepIndex}:${showCallables}:${guide}`} hover={hover} currentFrame={currentFrame} />
        </div>
      </div>
    </div>
  );
}

// -- Narration

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
      className="flex min-h-9 shrink-0 items-center gap-3 border-b border-line bg-surface-2/40 px-3 py-1.5 text-[12.5px]"
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
        className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden"
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
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle">
          {step.event === "line" ? "Next" : "At"}
          <span className="font-mono text-fg-muted">{`${top.file}:${top.line}`}</span>
        </span>
      )}
    </div>
  );
}

// -- Timeline

/** Scrubber showing call depth over the run, where output was printed and where exceptions happened. */
function Timeline({ trace, stepIndex, onSeek }: { trace: Trace; stepIndex: number; onSeek: (step: number) => void }) {
  const t = useMemo(() => timeline(trace), [trace]);
  const n = trace.steps.length;
  const at = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const h = t.maxDepth + 0.5;
  let area = `M 0 ${h}`;
  t.depth.forEach((d, i) => (area += ` L ${i} ${h - d} L ${i + 1} ${h - d}`));
  area += ` L ${n} ${h} Z`;
  return (
    <div className="relative mx-2 h-8 min-w-32 flex-1">
      <div className="absolute inset-x-0 bottom-1 top-1 overflow-hidden rounded-md bg-surface-2">
        <svg className="absolute inset-0 size-full" viewBox={`0 0 ${n} ${h}`} preserveAspectRatio="none" aria-hidden>
          <path d={area} fill="color-mix(in srgb, var(--accent) 22%, transparent)" />
        </svg>
        <div className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${at(stepIndex)}%` }} />
        {t.exceptions.map((i) => (
          <span key={`e${i}`} className="absolute inset-y-0 w-0.5 bg-danger" style={{ left: `${at(i)}%` }} />
        ))}
        {t.printed.map((i) => (
          <span
            key={`p${i}`}
            className="absolute bottom-0.5 size-1.5 -translate-x-1/2 rounded-full"
            style={{ left: `${at(i)}%`, background: "var(--viz-obj)" }}
          />
        ))}
      </div>
      <motion.span
        aria-hidden
        className="pointer-events-none absolute top-0 h-8 w-0.5 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]"
        animate={{ left: `${at(stepIndex)}%` }}
        transition={{ type: "spring", stiffness: 500, damping: 40 }}
      />
      <input
        type="range"
        aria-label="Step"
        min={0}
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
    <div className="flex w-[min(19rem,28%)] shrink-0 flex-col border-l border-line">
      <span className="px-3 pt-3 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Output</span>
      <pre ref={box} aria-label="Output so far" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[12.5px] text-fg">
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
        <Workflow className={cn("size-6 text-accent", recording && "animate-pulse")} />
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

/** Visualizer tool window: play or step through a recorded run and watch its frames and objects change. */
export function VisualizerPanel() {
  const trace = useVisualize((s) => s.trace);
  const stepIndex = useVisualize((s) => s.step);
  const playing = useVisualize((s) => s.playing);
  const speed = useVisualize((s) => s.speed);
  const showCallables = useVisualize((s) => s.showCallables);
  const chosenView = useVisualize((s) => s.view);
  const { go, next, prev, togglePlay, pause, setSpeed, setShowCallables } = useVisualize.getState();
  const run = useExecution((s) => s.run);
  const language = useWorkspace((s) => (s.project ? getLanguage(s.project.language) : undefined));
  const supported = !!language?.visualizer && language.visualizer.supportLevel !== "planned";
  const recording = run?.mode === "visualize" && isRunning(run);
  // Select primitives: a fresh object per render would loop zustand's subscription.
  const file = useVisualize((s) => stepLocation(s)?.file);
  const line = useVisualize((s) => stepLocation(s)?.line);
  const ids = useMemo(() => (trace ? frameIds(trace) : []), [trace]);
  const hasCallables = useMemo(() => !!trace?.steps.some((s) => Object.values(s.heap).some(isCallable)), [trace]);
  const total = trace?.steps.length ?? 0;
  const diff = useMemo(() => (trace && stepIndex < trace.steps.length ? diffSteps(trace, stepIndex) : null), [trace, stepIndex]);
  const structured = useMemo(() => (trace ? hasStructures(trace) : false), [trace]);
  const view = chosenView ?? (structured ? "structures" : "memory");

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
    return <p className="p-3 text-sm text-fg-subtle">The visualizer is available for Java, Python, JavaScript and TypeScript projects.</p>;
  }
  if (!trace || recording) {
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
        className="flex h-full min-h-0 flex-col outline-none"
        tabIndex={0}
        aria-label="Execution visualizer"
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement && e.key !== " ") return;
          const actions: Record<string, () => void> = {
            ArrowRight: manual(next),
            ArrowLeft: manual(prev),
            Home: manual(() => go(0)),
            End: manual(() => go(total - 1)),
            " ": togglePlay,
          };
          const action = actions[e.key];
          if (!action) return;
          e.preventDefault();
          action();
        }}
      >
        <div role="toolbar" aria-label="Step controls" className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line px-2">
          <IconButton label="First step" shortcut="Home" disabled={stepIndex === 0} onClick={manual(() => go(0))}>
            <ChevronFirst />
          </IconButton>
          <IconButton label="Previous step" shortcut="Left" disabled={stepIndex === 0} onClick={manual(prev)}>
            <ChevronLeft />
          </IconButton>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={togglePlay}
            className="mx-1 flex size-8 items-center justify-center rounded-full bg-accent text-accent-fg shadow-[0_4px_14px_-4px_var(--accent)] transition-transform hover:scale-105 active:scale-95 [&_svg]:size-4"
          >
            {playing ? <Pause /> : <Play className="translate-x-px" />}
          </button>
          <IconButton label="Next step" shortcut="Right" disabled={stepIndex === total - 1} onClick={manual(next)}>
            <ChevronRight />
          </IconButton>
          <IconButton label="Last step" shortcut="End" disabled={stepIndex === total - 1} onClick={manual(() => go(total - 1))}>
            <ChevronLast />
          </IconButton>
          <Timeline trace={trace} stepIndex={stepIndex} onSeek={(i) => (pause(), go(i))} />
          <span className="whitespace-nowrap text-sm tabular-nums text-fg">{`Step ${stepIndex + 1} of ${total}`}</span>
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
          <div role="group" aria-label="View" className="ml-2 flex rounded-md border border-line-strong p-0.5">
            {(["structures", "memory"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                title={
                  v === "structures"
                    ? "Each data structure drawn as its concept: stacks, queues, lists, trees, graphs, maps"
                    : "Frames, objects and the references between them"
                }
                onClick={() => useVisualize.getState().setView(v)}
                className={cn("rounded px-2 text-xs capitalize leading-5", view === v ? "bg-accent text-accent-fg" : "text-fg-subtle hover:text-fg")}
              >
                {v}
              </button>
            ))}
          </div>
          {hasCallables && view === "memory" && (
            <IconButton label="Show functions and classes as objects" active={showCallables} onClick={() => setShowCallables(!showCallables)} className="ml-1">
              <SquareFunction />
            </IconButton>
          )}
          {trace.truncated && (
            <span title={trace.truncated} className="ml-2 flex min-w-0 max-w-48 items-center gap-1 text-xs text-warning [&_svg]:size-3.5 [&_svg]:shrink-0">
              <TriangleAlert />
              <span className="truncate">{trace.truncated}</span>
            </span>
          )}
        </div>
        <Narration trace={trace} stepIndex={stepIndex} diff={diff} />
        <div className="flex min-h-0 flex-1">
          <LayoutGroup>
            {view === "structures" ? (
              <ConceptView trace={trace} stepIndex={stepIndex} diff={diff} />
            ) : (
              <Diagram trace={trace} stepIndex={stepIndex} diff={diff} ids={ids[stepIndex] ?? []} showCallables={showCallables} />
            )}
          </LayoutGroup>
          <Output trace={trace} stepIndex={stepIndex} printed={diff.printed} />
        </div>
      </div>
    </MotionConfig>
  );
}
