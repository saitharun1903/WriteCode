"use client";

import { ArrowDown, ArrowLeft, Boxes, GitBranch, Hash, Layers, Link2, ListOrdered, Network, Rows3, Share2, Table2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, type ReactNode } from "react";
import type { Trace, TraceStep, TraceValue } from "@cw/shared";
import { cn } from "@/lib/cn";
import { detectStructures, scalarText, stableKeys, structureTitle, type Structure, type TreeNode } from "./concepts";
import { preview, valueKey, type StepDiff } from "./model";

const SPRING = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } as const;

const NUMBER_TYPES = /^(int|float|complex|long|double|short|byte|Integer|Long|Double|Float|Short|Byte|BigInteger|BigDecimal)$/;
const STRING_TYPES = /^(str|String|char|Character|bytes)$/;
const KEYWORDS = new Set(["None", "null", "True", "False", "true", "false"]);

function color(v: TraceValue | null | undefined): string {
  if (!v || v.kind !== "value") return "var(--fg)";
  if (KEYWORDS.has(v.text)) return "var(--viz-kw)";
  if (NUMBER_TYPES.test(v.type)) return "var(--viz-num)";
  if (STRING_TYPES.test(v.type)) return "var(--viz-str)";
  return "var(--fg)";
}

/** A value as text: scalars as written, objects as a short preview. */
function Text({ step, value, className }: { step: TraceStep; value: TraceValue | null | undefined; className?: string }) {
  if (!value) return <span className="text-fg-faint">·</span>;
  const text = value.kind === "value" ? value.text : preview(step, value);
  return (
    <span title={text} style={{ color: color(value) }} className={cn("truncate font-mono", className)}>
      {text}
    </span>
  );
}

const ACCENT: Record<Structure["kind"], string> = {
  array: "var(--viz-array)",
  matrix: "var(--viz-array)",
  stack: "var(--viz-stack)",
  queue: "var(--viz-queue)",
  hash: "var(--viz-hash)",
  set: "var(--viz-hash)",
  list: "var(--viz-list)",
  tree: "var(--viz-tree)",
  graph: "var(--viz-graph)",
};

const ICON: Record<Structure["kind"], ReactNode> = {
  array: <ListOrdered />,
  matrix: <Table2 />,
  stack: <Layers />,
  queue: <Rows3 />,
  hash: <Hash />,
  set: <Boxes />,
  list: <Link2 />,
  tree: <GitBranch />,
  graph: <Network />,
};

function sizeLabel(s: Structure): string | null {
  switch (s.kind) {
    case "array":
    case "stack":
    case "queue":
    case "set":
      return `${s.items.length + ("omitted" in s ? s.omitted : 0)} item${s.items.length === 1 ? "" : "s"}`;
    case "hash":
      return `${s.entries.length + s.omitted} key${s.entries.length === 1 ? "" : "s"}`;
    case "matrix":
      return `${s.rows.length} × ${Math.max(0, ...s.rows.map((r) => r.items.length))}`;
    case "list":
      return `${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"}`;
    case "graph":
      return `${s.nodes.length} nodes · ${s.edges.length} edges`;
    case "tree": {
      let n = 0;
      const walk = (t: TreeNode | null) => t && (n++, t.children.forEach(walk));
      walk(s.root);
      return `${n} node${n === 1 ? "" : "s"}`;
    }
  }
}

function Card({ s, children, extra }: { s: Structure; children: ReactNode; extra?: ReactNode }) {
  const accent = ACCENT[s.kind];
  return (
    <motion.section
      layout="position"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRING}
      aria-label={`${structureTitle(s)} ${s.name}`}
      className="relative w-fit min-w-[15rem] max-w-full overflow-hidden rounded-xl border border-line-strong bg-surface-2 shadow-[0_8px_28px_-18px_rgb(0_0_0/0.5)]"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: accent }} />
      <header className="flex items-center gap-2 px-3.5 pb-1 pt-3">
        <span className="flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5" style={{ background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent }}>
          {ICON[s.kind]}
        </span>
        <span className="text-[13px] font-semibold text-fg">{structureTitle(s)}</span>
        <code className="rounded bg-surface-3 px-1.5 font-mono text-[12px] text-fg-muted">{s.name}</code>
        <span className="text-[11.5px] text-fg-subtle">{sizeLabel(s)}</span>
        {extra && <span className="ml-auto pl-3">{extra}</span>}
      </header>
      <div className="max-w-full overflow-x-auto px-3.5 pb-3.5 pt-2">{children}</div>
    </motion.section>
  );
}

/** "push 5", "dequeue 3"…: what the line did to a stack or queue, from the previous step. */
function lastOp(prev: TraceStep | undefined, s: Extract<Structure, { kind: "stack" | "queue" }>): { op: string; value?: TraceValue; removed?: TraceValue } | null {
  const before = prev?.heap[s.id];
  if (!before || before.kind !== "sequence") return null;
  const was = s.kind === "stack" && s.topFirst ? [...(before.items ?? [])].reverse() : (before.items ?? []);
  const now = s.items;
  const same = (a: TraceValue[], b: TraceValue[]) => a.length === b.length && a.every((x, i) => valueKey(x) === valueKey(b[i]));
  if (s.kind === "stack") {
    if (now.length === was.length + 1 && same(now.slice(0, -1), was)) return { op: "push", value: now.at(-1) };
    if (now.length === was.length - 1 && same(now, was.slice(0, -1))) return { op: "pop", removed: was.at(-1) };
    return null;
  }
  if (now.length === was.length + 1 && same(now.slice(0, -1), was)) return { op: "enqueue", value: now.at(-1) };
  if (now.length === was.length - 1 && same(now, was.slice(1))) return { op: "dequeue", removed: was[0] };
  if (s.deque && now.length === was.length + 1 && same(now.slice(1), was)) return { op: "push front", value: now[0] };
  if (s.deque && now.length === was.length - 1 && same(now, was.slice(0, -1))) return { op: "pop back", removed: was.at(-1) };
  return null;
}

function OpChip({ op, step }: { op: NonNullable<ReturnType<typeof lastOp>>; step: TraceStep }) {
  const adds = op.value !== undefined;
  return (
    <motion.span
      key={`${op.op}`}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold", adds ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}
    >
      {op.op}
      {(op.value ?? op.removed) && <Text step={step} value={op.value ?? op.removed} className="text-[11px]" />}
    </motion.span>
  );
}

// -- Arrays

const isTrue = (v: TraceValue) => v.kind === "value" && /^(bool|boolean|Boolean)$/.test(v.type) && /^(True|true)$/.test(v.text);

function ArrayView({ s, step, trace, stepIndex, diff }: { s: Extract<Structure, { kind: "array" }>; step: TraceStep; trace: Trace; stepIndex: number; diff: StepDiff }) {
  const keys = s.chars ? s.items.map((_, i) => `${s.id}:${i}`) : stableKeys(trace, s.id, stepIndex);
  const inRange = new Set<number>();
  // Between two pointers (a window or a search range): shade the cells in between.
  const idx = [...s.pointers.keys()].sort((a, b) => a - b);
  if (idx.length >= 2) for (let i = idx[0]!; i <= idx.at(-1)!; i++) inRange.add(i);
  return (
    <div className="flex items-start pb-1 pt-1">
      {s.items.map((item, i) => {
        const names = s.pointers.get(i) ?? [];
        const changed = diff.highlights.has(`cell:${s.id}:${i}`);
        return (
          <motion.div key={keys[i] ?? i} layout transition={SPRING} className="flex flex-col items-center">
            <span className="mb-0.5 text-[10px] tabular-nums leading-4 text-fg-faint">{i}</span>
            <div
              className={cn(
                "-ml-px flex h-11 min-w-11 items-center justify-center border px-2 text-[14px] transition-colors duration-300",
                i === 0 && "ml-0 rounded-l-lg",
                i === s.items.length - 1 && !s.omitted && "rounded-r-lg",
                names.length ? "z-10 border-[var(--viz-array)] bg-[color-mix(in_srgb,var(--viz-array)_16%,transparent)]" : isTrue(item) ? "border-line-strong bg-success-soft" : inRange.has(i) ? "border-line-strong bg-[color-mix(in_srgb,var(--viz-array)_7%,transparent)]" : "border-line-strong bg-surface",
                changed && "cw-viz-changed",
              )}
            >
              <Text step={step} value={item} className="max-w-[9rem] font-semibold" />
            </div>
            <div className="flex min-h-6 flex-col items-center pt-1">
              {names.map((n) => (
                <motion.span key={n} layoutId={`ptr:${s.id}:${n}`} transition={SPRING} className="flex flex-col items-center">
                  <span className="h-1.5 w-px bg-[var(--viz-array)]" />
                  <span className="rounded-full bg-[var(--viz-array)] px-1.5 font-mono text-[10.5px] font-bold leading-4 text-white">{n}</span>
                </motion.span>
              ))}
            </div>
          </motion.div>
        );
      })}
      {s.items.length === 0 && <span className="py-2 text-xs text-fg-subtle">empty</span>}
      {s.omitted > 0 && <span className="self-center px-2 text-xs text-fg-subtle">+{s.omitted} more</span>}
    </div>
  );
}

function MatrixView({ s, step, diff }: { s: Extract<Structure, { kind: "matrix" }>; step: TraceStep; diff: StepDiff }) {
  const cols = Math.max(0, ...s.rows.map((r) => r.items.length));
  const [ci, cj] = s.cell ?? [-1, -1];
  return (
    <table className="border-separate border-spacing-0 font-mono text-[13px]">
      <thead>
        <tr>
          <th />
          {Array.from({ length: Math.min(cols, 40) }, (_, j) => (
            <th key={j} className="px-1 pb-1 text-center align-bottom text-[10px] font-normal text-fg-faint">
              {s.colPointers.get(j)?.map((n) => (
                <motion.span key={n} layoutId={`col:${s.id}:${n}`} className="mb-0.5 block rounded-full bg-[var(--viz-array)] px-1 text-[10px] font-bold text-white">
                  {n}
                </motion.span>
              ))}
              {j}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {s.rows.slice(0, 40).map((r, i) => (
          <tr key={r.id}>
            <th className="pr-2 text-right text-[10px] font-normal text-fg-faint">
              <span className="inline-flex items-center gap-1">
                {s.rowPointers.get(i)?.map((n) => (
                  <motion.span key={n} layoutId={`row:${s.id}:${n}`} className="rounded-full bg-[var(--viz-array)] px-1 text-[10px] font-bold text-white">
                    {n}
                  </motion.span>
                ))}
                {i}
              </span>
            </th>
            {r.items.slice(0, 40).map((v, j) => {
              const here = i === ci && j === cj;
              const line = i === ci || j === cj;
              return (
                <td
                  key={j}
                  className={cn(
                    "h-9 min-w-9 border-b border-r border-line-strong px-2 text-center transition-colors duration-300",
                    i === 0 && "border-t",
                    j === 0 && "border-l",
                    here ? "bg-[color-mix(in_srgb,var(--viz-array)_28%,transparent)] outline outline-2 -outline-offset-2 outline-[var(--viz-array)]" : line ? "bg-[color-mix(in_srgb,var(--viz-array)_7%,transparent)]" : "bg-surface",
                    diff.highlights.has(`cell:${r.id}:${j}`) && "cw-viz-changed",
                  )}
                >
                  <Text step={step} value={v} className="font-semibold" />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -- Stack and queue

function StackView({ s, step, trace, stepIndex }: { s: Extract<Structure, { kind: "stack" }>; step: TraceStep; trace: Trace; stepIndex: number }) {
  const raw = stableKeys(trace, s.id, stepIndex);
  const keys = s.topFirst ? [...raw].reverse() : raw;
  const op = lastOp(trace.steps[stepIndex - 1], s);
  const shown = s.items.slice(-14);
  const offset = s.items.length - shown.length;
  return (
    <div className="flex items-end gap-4">
      <div className="flex flex-col items-center">
        <div className="relative flex min-h-[3.5rem] w-40 flex-col-reverse gap-1 rounded-b-xl border-x-[3px] border-b-[3px] border-[var(--viz-stack)] px-2 pb-2 pt-10">
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map((v, k) => {
              const i = k + offset;
              const top = i === s.items.length - 1;
              return (
                <motion.div
                  key={keys[i] ?? i}
                  layout
                  initial={{ opacity: 0, y: -46, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -60, x: 30, rotate: 8, transition: { duration: 0.35 } }}
                  transition={SPRING}
                  className={cn(
                    "relative flex h-10 items-center justify-center rounded-md border text-[14px] font-semibold",
                    top ? "border-[var(--viz-stack)] bg-[color-mix(in_srgb,var(--viz-stack)_22%,transparent)] shadow-[0_6px_16px_-8px_var(--viz-stack)]" : "border-line-strong bg-surface",
                  )}
                >
                  <Text step={step} value={v} className="max-w-[8rem]" />
                  {top && (
                    <span className="absolute left-full ml-3 flex items-center gap-1 whitespace-nowrap text-[11px] font-bold uppercase tracking-wider text-[var(--viz-stack)]">
                      <ArrowLeft className="size-3.5" />
                      Top
                    </span>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
          {s.items.length === 0 && <span className="py-2 text-center text-xs text-fg-subtle">empty</span>}
          {offset > 0 && <span className="text-center text-[11px] text-fg-subtle">+{offset} below</span>}
        </div>
        <span className="mt-1 text-[10.5px] uppercase tracking-wider text-fg-faint">bottom</span>
      </div>
      <div className="min-w-24 pb-8">{op && <OpChip op={op} step={step} />}</div>
    </div>
  );
}

function QueueView({ s, step, trace, stepIndex }: { s: Extract<Structure, { kind: "queue" }>; step: TraceStep; trace: Trace; stepIndex: number }) {
  const keys = stableKeys(trace, s.id, stepIndex);
  const op = lastOp(trace.steps[stepIndex - 1], s);
  const n = s.items.length;
  return (
    <div className="pt-1">
      <div className="mb-1 flex h-5 items-center justify-between gap-6 px-1 text-[10.5px] font-bold uppercase tracking-wider text-[var(--viz-queue)]">
        <span>{s.deque ? "Front" : "Front · head"}</span>
        <span>{op && <OpChip op={op} step={step} />}</span>
        <span>{s.deque ? "Back" : "Rear · tail"}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex flex-col items-center text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          <ArrowLeft className="size-5 text-[var(--viz-queue)]" />
          {s.deque ? "out / in" : "dequeue"}
        </span>
        <div className="flex min-h-[3.25rem] min-w-40 items-center gap-1.5 rounded-xl border-2 border-dashed border-[color-mix(in_srgb,var(--viz-queue)_45%,transparent)] p-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {s.items.slice(0, 24).map((v, i) => (
              <motion.div
                key={keys[i] ?? i}
                layout
                initial={{ opacity: 0, x: 48, scale: 0.85 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -48, y: 22, transition: { duration: 0.35 } }}
                transition={SPRING}
                className={cn(
                  "flex h-10 min-w-11 items-center justify-center rounded-md border px-2 text-[14px] font-semibold",
                  i === 0 || i === n - 1 ? "border-[var(--viz-queue)] bg-[color-mix(in_srgb,var(--viz-queue)_20%,transparent)]" : "border-line-strong bg-[color-mix(in_srgb,var(--viz-queue)_7%,var(--surface))]",
                )}
              >
                <Text step={step} value={v} className="max-w-[8rem]" />
              </motion.div>
            ))}
          </AnimatePresence>
          {n === 0 && <span className="px-2 text-xs text-fg-subtle">empty</span>}
          {n > 24 && <span className="px-1 text-xs text-fg-subtle">+{n - 24}</span>}
        </div>
        <span className="flex flex-col items-center text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
          <ArrowLeft className="size-5 text-[var(--viz-queue)]" />
          {s.deque ? "in / out" : "enqueue"}
        </span>
      </div>
    </div>
  );
}

// -- Hash map and set

function HashView({ s, step, diff }: { s: Extract<Structure, { kind: "hash" }>; step: TraceStep; diff: StepDiff }) {
  return (
    <div className="min-w-[14rem] overflow-hidden rounded-xl border-2 border-[color-mix(in_srgb,var(--viz-hash)_45%,transparent)]">
      <div className="grid grid-cols-2 border-b-2 border-[color-mix(in_srgb,var(--viz-hash)_45%,transparent)] bg-[color-mix(in_srgb,var(--viz-hash)_12%,transparent)] text-[11px] font-bold uppercase tracking-wider text-[var(--viz-hash)]">
        <span className="border-r-2 border-[color-mix(in_srgb,var(--viz-hash)_45%,transparent)] px-3 py-1.5">Key</span>
        <span className="px-3 py-1.5">Value</span>
      </div>
      <AnimatePresence initial={false}>
        {s.entries.slice(0, 40).map(([k, v]) => {
          const hl = `key:${s.id}:${valueKey(k)}`;
          return (
            <motion.div
              key={valueKey(k)}
              layout
              initial={{ opacity: 0, x: -16, backgroundColor: "color-mix(in srgb, var(--viz-hash) 30%, transparent)" }}
              animate={{ opacity: 1, x: 0, backgroundColor: "rgba(0,0,0,0)" }}
              exit={{ opacity: 0, x: 16, transition: { duration: 0.2 } }}
              transition={SPRING}
              className="grid grid-cols-2 border-b border-line-strong/60 text-[13.5px] last:border-b-0"
            >
              <span className="truncate border-r-2 border-[color-mix(in_srgb,var(--viz-hash)_45%,transparent)] px-3 py-1.5">
                <Text step={step} value={k} className="font-semibold" />
              </span>
              <span className={cn("truncate px-3 py-1.5", diff.highlights.has(hl) && "cw-viz-changed")}>
                <Text step={step} value={v} />
              </span>
            </motion.div>
          );
        })}
      </AnimatePresence>
      {s.entries.length === 0 && <div className="px-3 py-3 text-center text-xs text-fg-subtle">empty</div>}
      {s.omitted > 0 && <div className="px-3 py-1 text-center text-xs text-fg-subtle">+{s.omitted} more</div>}
    </div>
  );
}

function SetView({ s, step }: { s: Extract<Structure, { kind: "set" }>; step: TraceStep }) {
  return (
    <div className="flex max-w-[36rem] flex-wrap items-center gap-1.5 rounded-2xl border-2 border-[color-mix(in_srgb,var(--viz-hash)_45%,transparent)] bg-[color-mix(in_srgb,var(--viz-hash)_5%,transparent)] px-3 py-2.5">
      <span className="font-mono text-lg text-[var(--viz-hash)]">{"{"}</span>
      <AnimatePresence initial={false}>
        {s.items.slice(0, 60).map((v) => (
          <motion.span
            key={valueKey(v)}
            layout
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={SPRING}
            className="rounded-full border border-[color-mix(in_srgb,var(--viz-hash)_50%,transparent)] bg-surface px-2.5 py-0.5 text-[13px] font-semibold"
          >
            <Text step={step} value={v} />
          </motion.span>
        ))}
      </AnimatePresence>
      {s.items.length === 0 && <span className="text-xs text-fg-subtle">empty</span>}
      {s.omitted > 0 && <span className="text-xs text-fg-subtle">+{s.omitted}</span>}
      <span className="font-mono text-lg text-[var(--viz-hash)]">{"}"}</span>
    </div>
  );
}

// -- Linked list

function NullBox() {
  return (
    <span aria-label="null" className="relative flex h-11 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border-2 border-[var(--viz-list)] bg-surface">
      <svg viewBox="0 0 36 44" className="absolute inset-0 size-full text-[var(--viz-list)]" preserveAspectRatio="none">
        <path d="M0 0 L36 44 M36 0 L0 44" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </span>
  );
}

function ListView({ s, step, diff }: { s: Extract<Structure, { kind: "list" }>; step: TraceStep; diff: StepDiff }) {
  const doubly = s.variant === "doubly" || s.variant === "circular-doubly";
  const circular = s.variant.startsWith("circular");
  const cell = "flex h-11 items-center border-[var(--viz-list)]";
  return (
    <div className="relative inline-flex flex-col pb-1 pt-1">
      <div className="flex items-end">
        {doubly && !circular && (
          <>
            <NullBox />
            <span className="mx-1 mb-4 font-mono text-xs text-[var(--viz-list)]">←</span>
          </>
        )}
        <AnimatePresence initial={false} mode="popLayout">
          {s.nodes.map((n, i) => {
            const names = s.pointers.get(n.id) ?? [];
            const changed = [...diff.highlights].some((h) => h.startsWith(`field:${n.id}:`) || h === `obj:${n.id}`);
            return (
              <motion.div
                key={n.id}
                layout
                initial={{ opacity: 0, y: -24, scale: 0.85 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 24, scale: 0.85, transition: { duration: 0.25 } }}
                transition={SPRING}
                className="flex items-end"
              >
                <div className="flex flex-col items-center">
                  <div className="flex min-h-7 flex-wrap items-end justify-center gap-0.5 pb-1">
                    {names.map((p) => (
                      <motion.span key={p} layoutId={`lptr:${s.id}:${p}`} transition={SPRING} className="flex flex-col items-center">
                        <span className="rounded-full bg-[var(--viz-list)] px-1.5 font-mono text-[10.5px] font-bold leading-4 text-white">{p}</span>
                        <ArrowDown className="size-3 text-[var(--viz-list)]" />
                      </motion.span>
                    ))}
                  </div>
                  <div className={cn("flex overflow-hidden rounded-md border-2 border-[var(--viz-list)] bg-surface shadow-[0_6px_16px_-10px_var(--viz-list)]", changed && "cw-viz-changed")}>
                    {doubly && <span className={cn(cell, "w-5 justify-center border-r-2 text-[var(--viz-list)]")}>•</span>}
                    <span className={cn(cell, "min-w-11 justify-center px-2 text-[14px] font-semibold")}>
                      <Text step={step} value={n.value} className="max-w-[7rem]" />
                    </span>
                    <span className={cn(cell, "w-6 justify-center border-l-2 text-[var(--viz-list)]")}>•</span>
                  </div>
                </div>
                {(i < s.nodes.length - 1 || !circular) && (
                  <span className="mb-[0.8rem] flex w-9 flex-col items-center font-mono text-[13px] leading-3 text-[var(--viz-list)]">
                    <span>⟶</span>
                    {doubly && i < s.nodes.length - 1 && <span>⟵</span>}
                  </span>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
        {!circular && !s.truncated && <NullBox />}
        {s.truncated && <span className="mb-3 px-2 text-xs text-fg-subtle">…</span>}
      </div>
      {circular && s.nodes.length > 0 && (
        <div aria-hidden className="relative mx-[1.4rem] mt-1 h-5 rounded-b-xl border-x-2 border-b-2 border-[var(--viz-list)]">
          <span className="absolute -left-[7px] -top-2 font-mono text-[12px] leading-3 text-[var(--viz-list)]">▲</span>
          <span className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 bg-surface-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--viz-list)]">back to {s.pointers.get(s.nodes[0]!.id)?.[0] ?? "head"}</span>
        </div>
      )}
    </div>
  );
}

// -- Trees

interface Placed {
  node: TreeNode;
  x: number;
  y: number;
  parent?: Placed;
}

/** Binary trees by in-order position (so a BST reads sorted left to right); others by their leaves. */
function placeTree(root: TreeNode, binary: boolean): Placed[] {
  const out: Placed[] = [];
  let next = 0;
  const walk = (n: TreeNode, depth: number, parent?: Placed): Placed => {
    const p: Placed = { node: n, x: 0, y: depth, parent };
    if (binary) {
      const [l, r] = n.children;
      if (l) walk(l, depth + 1, p);
      p.x = next++;
      out.push(p);
      if (r) walk(r, depth + 1, p);
    } else {
      out.push(p);
      const kids = n.children.filter((c): c is TreeNode => !!c).map((c) => walk(c, depth + 1, p));
      if (kids.length === 0) p.x = next++;
      else p.x = (kids[0]!.x + kids.at(-1)!.x) / 2;
    }
    return p;
  };
  walk(root, 0);
  return out;
}

/** Tries: the word spelled on the way down to a node. */
function prefixOf(p: Placed): string {
  let out = "";
  for (let x: Placed | undefined = p; x?.parent; x = x.parent) out = (x.node.edge ?? "") + out;
  return out;
}

function TreeView({ s, step, trace, stepIndex, diff }: { s: Extract<Structure, { kind: "tree" }>; step: TraceStep; trace: Trace; stepIndex: number; diff: StepDiff }) {
  const binary = s.variant === "binary" || s.variant === "bst" || s.variant === "avl" || s.variant === "red-black" || s.variant === "heap" || s.variant === "segment";
  const placed = placeTree(s.root, binary);
  const arrayKeys = s.items ? stableKeys(trace, s.id, stepIndex) : null;
  const keyOf = (n: TreeNode) => (s.variant === "heap" && arrayKeys && n.index !== undefined ? (arrayKeys[n.index] ?? n.key) : n.key);
  const GX = 58;
  const GY = 72;
  const R = 19;
  const maxX = Math.max(0, ...placed.map((p) => p.x));
  const maxY = Math.max(0, ...placed.map((p) => p.y));
  const width = (maxX + 1) * GX + 40;
  const height = (maxY + 1) * GY + 40;
  const px = (p: Placed) => 20 + GX / 2 + p.x * GX;
  const py = (p: Placed) => 40 + p.y * GY;
  const changed = (n: TreeNode) =>
    n.index !== undefined ? diff.highlights.has(`cell:${s.id}:${n.index}`) : [...diff.highlights].some((h) => h.startsWith(`field:${n.key}:`));
  return (
    <div className="flex flex-col gap-3">
      <svg width={width} height={height} className="overflow-visible" role="img" aria-label={`${structureTitle(s)} with ${placed.length} nodes`}>
        <AnimatePresence initial={false}>
          {placed
            .filter((p) => p.parent)
            .map((p) => (
              <motion.line
                key={`e:${keyOf(p.node)}`}
                initial={{ opacity: 0 }}
                animate={{ x1: px(p.parent!), y1: py(p.parent!), x2: px(p), y2: py(p), opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={SPRING}
                stroke="color-mix(in srgb, var(--viz-tree) 55%, var(--line-strong))"
                strokeWidth={2}
              />
            ))}
        </AnimatePresence>
        {s.variant === "trie" &&
          placed
            .filter((p) => p.parent && p.node.edge)
            .map((p) => (
              <text key={`t:${p.node.key}`} x={(px(p.parent!) + px(p)) / 2 + 7} y={(py(p.parent!) + py(p)) / 2} className="fill-[var(--viz-tree)] font-mono text-[12px] font-bold">
                {p.node.edge}
              </text>
            ))}
        <AnimatePresence initial={false}>
          {placed.map((p) => {
            const n = p.node;
            const rb = s.variant === "red-black";
            const fill = rb ? (n.color === "red" ? "#d9434f" : "#23262b") : n.end ? "color-mix(in srgb, var(--success) 22%, var(--surface))" : "var(--surface)";
            const stroke = rb ? (n.color === "red" ? "#ff8a8f" : "#6b6f78") : n.end ? "var(--success)" : "var(--viz-tree)";
            const names = s.pointers.get(n.key) ?? [];
            const text = s.variant === "trie" ? (p.parent ? prefixOf(p) : "root") : n.label ? (scalarText(n.label) ?? preview(step, n.label)) : "";
            return (
              <motion.g
                key={keyOf(n)}
                initial={{ opacity: 0, scale: 0.4, x: px(p), y: py(p) }}
                animate={{ opacity: 1, scale: 1, x: px(p), y: py(p) }}
                exit={{ opacity: 0, scale: 0.4 }}
                transition={SPRING}
              >
                {changed(n) && <circle r={R + 6} fill="none" stroke="var(--warning)" strokeWidth={3} className="cw-viz-pulse" />}
                {names.length > 0 && <circle r={R + 5} fill="none" stroke="var(--success)" strokeWidth={3} className="cw-viz-pulse" />}
                <circle r={R} fill={fill} stroke={stroke} strokeWidth={2.5} />
                {n.end && !rb && <circle r={R - 4} fill="none" stroke="var(--success)" strokeWidth={1.5} />}
                <text textAnchor="middle" dy="0.35em" className={cn("font-mono text-[12.5px] font-bold", rb ? "fill-white" : "fill-[var(--fg)]")} style={text === "root" ? { fontSize: 10 } : undefined}>
                  {text.length > 5 ? `${text.slice(0, 4)}…` : text}
                </text>
                {n.height !== undefined && (
                  <g transform={`translate(${R - 2},${-R + 2})`}>
                    <rect x={-2} y={-8} width={24} height={14} rx={7} fill="var(--viz-tree)" />
                    <text x={10} y={2} textAnchor="middle" className="fill-white font-mono text-[9px] font-bold">
                      h{n.height}
                    </text>
                  </g>
                )}
                {n.index !== undefined && (
                  <text y={R + 12} textAnchor="middle" className="fill-[var(--fg-faint)] font-mono text-[9.5px]">
                    [{n.index}]
                  </text>
                )}
                {names.length > 0 && (
                  <text x={R + 5} y={-R + 4} textAnchor="start" className="fill-[var(--success)] font-mono text-[10.5px] font-bold">
                    {names.join(", ")}
                  </text>
                )}
              </motion.g>
            );
          })}
        </AnimatePresence>
      </svg>
      {s.items && s.variant === "heap" && (
        <ArrayRow items={s.items} keys={arrayKeys ?? []} step={step} id={s.id} diff={diff} label="as an array" />
      )}
    </div>
  );
}

function ArrayRow({ items, keys, step, id, diff, label }: { items: TraceValue[]; keys: string[]; step: TraceStep; id: string; diff: StepDiff; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10.5px] uppercase tracking-wider text-fg-faint">{label}</span>
      <div className="flex">
        {items.slice(0, 32).map((v, i) => (
          <motion.div key={keys[i] ?? i} layout transition={SPRING} className="flex flex-col items-center">
            <span className="text-[9.5px] text-fg-faint">{i}</span>
            <span className={cn("-ml-px flex h-8 min-w-9 items-center justify-center border border-line-strong bg-surface px-1.5 text-[12.5px] font-semibold", i === 0 && "ml-0 rounded-l-md", i === items.length - 1 && "rounded-r-md", diff.highlights.has(`cell:${id}:${i}`) && "cw-viz-changed")}>
              <Text step={step} value={v} />
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// -- Graph

function GraphView({ s }: { s: Extract<Structure, { kind: "graph" }> }) {
  const nodes = [...s.nodes].sort((a, b) => (/^\d+$/.test(a.key) && /^\d+$/.test(b.key) ? Number(a.key) - Number(b.key) : a.key.localeCompare(b.key)));
  const n = nodes.length;
  const R = 20;
  const { pos, width, height } = layoutGraph(nodes.map((x) => x.key), s.edges);
  const both = (e: { from: string; to: string }) => s.directed && s.edges.some((x) => x.from === e.to && x.to === e.from);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <svg width={width} height={height} role="img" aria-label={`${structureTitle(s)} with ${n} nodes`}>
        <defs>
          <marker id={`gh-${s.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--viz-graph)" />
          </marker>
        </defs>
        {s.edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b || e.from === e.to) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const [ux, uy] = [dx / len, dy / len];
          // Start and end on the circles; bend when both directions exist.
          const bend = both(e) ? 18 : 0;
          const x1 = a.x + ux * R;
          const y1 = a.y + uy * R;
          const x2 = b.x - ux * (R + (s.directed ? 3 : 0));
          const y2 = b.y - uy * (R + (s.directed ? 3 : 0));
          const mx = (x1 + x2) / 2 - uy * bend;
          const my = (y1 + y2) / 2 + ux * bend;
          const active = (s.current.has(e.from) && s.checking.has(e.to)) || (!s.directed && s.current.has(e.to) && s.checking.has(e.from));
          return (
            <g key={`${e.from}>${e.to}:${i}`}>
              <path
                d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
                fill="none"
                stroke={active ? "var(--viz-hash)" : "color-mix(in srgb, var(--viz-graph) 40%, var(--line-strong))"}
                strokeWidth={active ? 3 : 1.8}
                markerEnd={s.directed ? `url(#gh-${s.id})` : undefined}
                className="transition-[stroke,stroke-width] duration-300"
              />
              {e.weight !== undefined && (
                <g transform={`translate(${(x1 + x2) / 2 - uy * bend * 0.5},${(y1 + y2) / 2 + ux * bend * 0.5})`}>
                  <rect x={-11} y={-8} width={22} height={16} rx={4} fill="var(--surface-2)" stroke="color-mix(in srgb, var(--viz-graph) 40%, transparent)" />
                  <text textAnchor="middle" dy="0.35em" className="fill-[var(--fg-muted)] font-mono text-[10px] font-semibold">
                    {e.weight.length > 4 ? `${e.weight.slice(0, 3)}…` : e.weight}
                  </text>
                </g>
              )}
            </g>
          );
        })}
        {nodes.map((node) => {
          const p = pos.get(node.key)!;
          const visited = s.visited.has(node.key);
          const current = s.current.has(node.key);
          const checking = s.checking.has(node.key) && !current;
          const frontier = s.frontier.has(node.key);
          const badge = s.badges.get(node.key);
          return (
            <g key={node.key} transform={`translate(${p.x},${p.y})`}>
              {current && <circle r={R + 6} fill="none" stroke="var(--success)" className="cw-viz-pulse" />}
              {checking && <circle r={R + 5} fill="none" stroke="var(--viz-hash)" strokeWidth={2.5} strokeDasharray="3 3" />}
              <motion.circle
                r={R}
                initial={false}
                animate={{
                  fill: visited ? "color-mix(in srgb, var(--viz-graph) 30%, var(--surface))" : "var(--surface)",
                  stroke: current ? "var(--success)" : frontier ? "var(--warning)" : "var(--viz-graph)",
                }}
                strokeWidth={2.5}
                strokeDasharray={frontier && !visited ? "5 3" : undefined}
              />
              <text textAnchor="middle" dy="0.35em" className="fill-[var(--fg)] font-mono text-[12.5px] font-bold">
                {node.label.length > 5 ? `${node.label.slice(0, 4)}…` : node.label}
              </text>
              {badge !== undefined && (
                <g transform={`translate(0,${R + 11})`}>
                  <rect x={-16} y={-8} width={32} height={15} rx={7} fill="var(--viz-graph)" />
                  <text textAnchor="middle" dy="0.32em" className="fill-white font-mono text-[9.5px] font-bold">
                    {badge.length > 5 ? "∞" : badge}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
      {(s.visited.size > 0 || s.frontier.size > 0 || s.current.size > 0 || s.checking.size > 0 || s.badges.size > 0) && (
        <ul className="space-y-1.5 pt-2 text-[11.5px] text-fg-muted">
          {s.current.size > 0 && <Legend swatch="border-[var(--success)]" text="current node" />}
          {s.checking.size > 0 && <Legend swatch="border-dashed border-[var(--viz-hash)]" text="neighbour being checked" />}
          {s.visited.size > 0 && <Legend swatch="border-[var(--viz-graph)] bg-[color-mix(in_srgb,var(--viz-graph)_30%,transparent)]" text={`visited (${s.visited.size})`} />}
          {s.frontier.size > 0 && <Legend swatch="border-dashed border-[var(--warning)]" text="waiting in the queue / stack" />}
          {s.badges.size > 0 && <Legend swatch="border-[var(--viz-graph)] bg-[var(--viz-graph)]" text="distance" />}
        </ul>
      )}
    </div>
  );
}

const layoutCache = new Map<string, { pos: Map<string, { x: number; y: number }>; width: number; height: number }>();

/**
 * Force-directed positions (Fruchterman-Reingold) from a fixed circular start,
 * so the same graph always lands the same way and keeps its shape from step to step.
 */
function layoutGraph(keys: string[], edges: { from: string; to: string }[]) {
  const sig = `${keys.join(",")}|${edges.map((e) => `${e.from}>${e.to}`).join(",")}`;
  const hit = layoutCache.get(sig);
  if (hit) return hit;
  const n = keys.length;
  const k = Math.max(260, 92 * Math.sqrt(n)) / Math.sqrt(Math.max(1, n));
  const p = keys.map((_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    return { x: Math.cos(a) * k * 1.2, y: Math.sin(a) * k * 1.2 };
  });
  const index = new Map(keys.map((key, i) => [key, i]));
  const links = edges
    .map((e) => [index.get(e.from), index.get(e.to)])
    .filter((l): l is [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);
  let t = k;
  for (let it = 0; it < 260; it++) {
    const d = p.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = p[i]!.x - p[j]!.x;
        const dy = p[i]!.y - p[j]!.y;
        const dist = Math.max(0.01, Math.hypot(dx, dy));
        const f = (k * k) / dist;
        d[i]!.x += (dx / dist) * f;
        d[i]!.y += (dy / dist) * f;
        d[j]!.x -= (dx / dist) * f;
        d[j]!.y -= (dy / dist) * f;
      }
    for (const [a, b] of links) {
      const dx = p[a]!.x - p[b]!.x;
      const dy = p[a]!.y - p[b]!.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const f = (dist * dist) / k;
      d[a]!.x -= (dx / dist) * f;
      d[a]!.y -= (dy / dist) * f;
      d[b]!.x += (dx / dist) * f;
      d[b]!.y += (dy / dist) * f;
    }
    // A gentle pull to the centre keeps separate components together.
    for (let i = 0; i < n; i++) {
      d[i]!.x -= p[i]!.x * 0.05;
      d[i]!.y -= p[i]!.y * 0.05;
      const len = Math.max(0.01, Math.hypot(d[i]!.x, d[i]!.y));
      p[i]!.x += (d[i]!.x / len) * Math.min(len, t);
      p[i]!.y += (d[i]!.y / len) * Math.min(len, t);
    }
    t = Math.max(1, t * 0.97);
  }
  const pad = 36;
  const minX = Math.min(...p.map((q) => q.x));
  const minY = Math.min(...p.map((q) => q.y));
  const maxX = Math.max(...p.map((q) => q.x));
  const maxY = Math.max(...p.map((q) => q.y));
  // Scale so the closest pair of nodes is still comfortably apart.
  let closest = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) closest = Math.min(closest, Math.hypot(p[i]!.x - p[j]!.x, p[i]!.y - p[j]!.y));
  const scale = Math.min(1.6, Math.max(0.5, Number.isFinite(closest) ? 70 / closest : 1));
  const pos = new Map(keys.map((key, i) => [key, { x: pad + (p[i]!.x - minX) * scale, y: pad + (p[i]!.y - minY) * scale }]));
  const out = { pos, width: (maxX - minX) * scale + 2 * pad, height: (maxY - minY) * scale + 2 * pad + 14 };
  if (layoutCache.size > 50) layoutCache.clear();
  layoutCache.set(sig, out);
  return out;
}

function Legend({ swatch, text }: { swatch: string; text: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn("size-3.5 rounded-full border-2", swatch)} />
      {text}
    </li>
  );
}

// -- The view

function StructureCard({ s, step, trace, stepIndex, diff }: { s: Structure; step: TraceStep; trace: Trace; stepIndex: number; diff: StepDiff }) {
  switch (s.kind) {
    case "array":
      return (
        <Card s={s}>
          <ArrayView s={s} step={step} trace={trace} stepIndex={stepIndex} diff={diff} />
        </Card>
      );
    case "matrix":
      return (
        <Card s={s}>
          <MatrixView s={s} step={step} diff={diff} />
        </Card>
      );
    case "stack":
      return (
        <Card s={s}>
          <StackView s={s} step={step} trace={trace} stepIndex={stepIndex} />
        </Card>
      );
    case "queue":
      return (
        <Card s={s}>
          <QueueView s={s} step={step} trace={trace} stepIndex={stepIndex} />
        </Card>
      );
    case "hash":
      return (
        <Card s={s}>
          <HashView s={s} step={step} diff={diff} />
        </Card>
      );
    case "set":
      return (
        <Card s={s}>
          <SetView s={s} step={step} />
        </Card>
      );
    case "list":
      return (
        <Card s={s}>
          <ListView s={s} step={step} diff={diff} />
        </Card>
      );
    case "tree":
      return (
        <Card s={s} extra={s.variant === "bst" ? <span className="text-[11px] text-fg-subtle">left &lt; node &lt; right</span> : s.variant === "segment" ? <span className="text-[11px] text-fg-subtle">each node covers a range</span> : undefined}>
          <TreeView s={s} step={step} trace={trace} stepIndex={stepIndex} diff={diff} />
        </Card>
      );
    case "graph":
      return (
        <Card s={s} extra={<span className="text-[11px] text-fg-subtle">{s.directed ? "directed" : "undirected"}{s.edges.some((e) => e.weight !== undefined) ? " · weighted" : ""}</span>}>
          <GraphView s={s} />
        </Card>
      );
  }
}

/** The call stack and the current function's plain variables, in one line above the structures. */
function Context({ step, diff }: { step: TraceStep; diff: StepDiff }) {
  const top = step.frames.length - 1;
  const frame = step.frames[top];
  const scalars = (frame?.locals ?? []).filter(([, v]) => v.kind === "value");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
      <nav aria-label="Call stack" className="flex flex-wrap items-center gap-1 font-mono text-[12px]">
        {step.frames.map((f, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-fg-faint">›</span>}
            <span className={cn("rounded-md px-1.5 py-0.5", i === top ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg-muted")}>{f.name}</span>
          </span>
        ))}
        {step.frames.length > 6 && <span className="ml-1 text-[11px] text-fg-subtle">depth {step.frames.length}</span>}
      </nav>
      {scalars.length > 0 && (
        <div aria-label="Variables" className="flex flex-wrap items-center gap-1.5">
          {scalars.map(([n, v]) => (
            <span key={n} className={cn("inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[12px]", diff.highlights.has(`var:${top}:${n}`) && "cw-viz-changed")}>
              <span className="text-fg-muted">{n}</span>
              <span className="text-fg-faint">=</span>
              <span style={{ color: color(v) }} className="max-w-[10rem] truncate font-semibold">
                {v.kind === "value" ? v.text : ""}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Structures of the current step, each drawn as its concept. */
export function useStructures(trace: Trace, stepIndex: number): Structure[] {
  return useMemo(() => {
    const step = trace.steps[stepIndex];
    return step ? detectStructures(step) : [];
  }, [trace, stepIndex]);
}

/** Whether any step of the trace has a structure worth the concept view. */
export function hasStructures(trace: Trace): boolean {
  const sample = trace.steps.length <= 40 ? trace.steps : trace.steps.filter((_, i) => i % Math.ceil(trace.steps.length / 40) === 0).concat(trace.steps.at(-1)!);
  return sample.some((s) => detectStructures(s).some((x) => x.kind !== "array" || x.pointers.size > 0 || x.items.length > 0));
}

export function ConceptView({ trace, stepIndex, diff }: { trace: Trace; stepIndex: number; diff: StepDiff }) {
  const step = trace.steps[stepIndex]!;
  const structures = useStructures(trace, stepIndex);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Context step={step} diff={diff} />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {structures.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-fg-subtle">
            <Share2 className="size-4" />
            No data structures at this step yet. They appear as the program creates them.
          </p>
        ) : (
          <div className="flex flex-wrap items-start gap-4">
            <AnimatePresence initial={false}>
              {structures.map((s) => (
                <StructureCard key={`${s.kind}:${s.id}`} s={s} step={step} trace={trace} stepIndex={stepIndex} diff={diff} />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
