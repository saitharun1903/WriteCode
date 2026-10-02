"use client";

import {
  AlertTriangle,
  ArrowDownToDot,
  ArrowUpFromDot,
  ChevronRight,
  CircleDot,
  Eye,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { basename, getLanguage, type DebugFrame, type DebugVariable } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { canDebug, primaryShortcut, runCommand } from "@/features/commands/registry";
import { goToLocation } from "@/features/editor/navigate";
import { ConsoleView } from "@/features/execution/OutputPanel";
import { isOwnRun, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { sourceTypeName } from "@/features/visualize/model";
import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";
import { Spinner } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { previewOf, shortValue } from "./inline-values";
import { frameKey, useDebug, type StopInfo } from "./store";

const INDENT = 16;

/** Colours values like the editor does: numbers, strings, keywords. */
export function valueColor(value: string): string {
  if (value === "null" || value === "None" || value === "true" || value === "false" || value === "True" || value === "False") return "var(--viz-kw)";
  if (value.startsWith('"') || value.startsWith("'")) return "var(--viz-str)";
  if (/^-?\d/.test(value)) return "var(--viz-num)";
  return "var(--fg-muted)";
}

/** Short type name for the badge: `java.util.ArrayList` becomes `ArrayList`. */
function shortType(type: string): string {
  const generic = type.indexOf("<");
  const base = generic >= 0 ? type.slice(0, generic) : type;
  return sourceTypeName(base.slice(base.lastIndexOf(".") + 1)) + (generic >= 0 ? type.slice(generic) : "");
}

/** Collections small enough that their contents are loaded up front, for the inline preview. */
const PREVIEW_MAX = 20;

/** The paused frame's values at the previous pause, when comparing makes sense. */
function usePrevious(depth: number): Record<string, string> | null {
  return useDebug((s) => (depth === 0 && s.stop && s.previous?.frame === frameKey(s.stop.frames, s.selectedFrame) ? s.previous.values : null));
}

/** Variable row. Expandable values load their children on first open; small collections preview their contents. */
function VariableRow({ variable, depth }: { variable: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false);
  const children = useDebug((s) => (variable.ref ? s.variables[variable.ref] : undefined));
  const previous = usePrevious(depth);
  const expandable = variable.ref > 0;
  // Java reports collection sizes in the value text, e.g. "ArrayList (size 1)".
  const size = variable.length ?? Number(/\bsize[ =](\d+)/.exec(variable.value)?.[1] ?? NaN);
  const small = expandable && Number.isFinite(size) && size <= PREVIEW_MAX;
  const before = previous?.[variable.name];
  const changed = previous !== null && before !== undefined && before !== variable.value;
  const added = previous !== null && before === undefined;

  useEffect(() => {
    if (small && !children) useDebug.getState().loadVariables(variable.ref);
  }, [small, children, variable.ref]);

  const toggle = () => {
    if (!expandable) return;
    if (!open && !children) useDebug.getState().loadVariables(variable.ref);
    setOpen(!open);
  };
  const preview = children?.status === "ready" ? previewOf(children.variables) : null;

  return (
    <>
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={expandable ? open : undefined}
        aria-selected={false}
        aria-label={`${variable.name} = ${variable.value}`}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || (e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
            e.preventDefault();
            toggle();
          }
        }}
        className="group flex h-[26px] items-center gap-1.5 pr-3 font-mono text-[13px] hover:bg-hover focus-visible:bg-accent-soft"
        style={{ paddingLeft: 8 + depth * INDENT }}
      >
        {expandable ? (
          <ChevronRight className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform duration-150", open && "rotate-90")} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="shrink-0 text-fg">{variable.name}</span>
        <span className="shrink-0 text-fg-faint">=</span>
        <span
          key={changed ? `c:${variable.value}` : "v"}
          style={{ color: valueColor(variable.value) }}
          className={cn("min-w-0 truncate rounded-[4px] px-0.5", (changed || added) && "cw-viz-changed")}
        >
          {preview && !open ? <span>{preview}</span> : variable.value}
        </span>
        {changed && <span className="shrink-0 truncate text-[11px] text-fg-subtle">was {shortValue(before!, 24)}</span>}
        {variable.type && (
          <span className="ml-auto shrink-0 rounded bg-hover px-1.5 font-sans text-[10.5px] leading-4 text-fg-subtle opacity-70 group-hover:opacity-100">
            {shortType(variable.type)}
          </span>
        )}
      </div>
      {open && expandable && <VariableChildren parentRef={variable.ref} depth={depth + 1} />}
    </>
  );
}

function SkeletonRows({ count = 3, depth = 0 }: { count?: number; depth?: number }) {
  return (
    <div aria-label="Collecting data" className="py-1">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-[26px] items-center gap-2" style={{ paddingLeft: 30 + depth * INDENT }}>
          <span className="h-2.5 animate-pulse rounded bg-hover" style={{ width: 40 + ((i * 23) % 40) }} />
          <span className="h-2.5 animate-pulse rounded bg-hover" style={{ width: 70 + ((i * 37) % 60) }} />
        </div>
      ))}
    </div>
  );
}

function VariableChildren({ parentRef, depth }: { parentRef: number; depth: number }) {
  const state = useDebug((s) => s.variables[parentRef]);
  const pad = { paddingLeft: 8 + depth * INDENT + 20 };
  if (!state || state.status === "loading") return <SkeletonRows count={depth === 0 ? 4 : 2} depth={depth} />;
  if (state.status === "error") {
    return (
      <p className="py-1 pr-2 text-sm text-danger" style={pad}>
        {state.message}
      </p>
    );
  }
  if (state.variables.length === 0) {
    return (
      <p className="py-1 text-sm text-fg-subtle" style={pad}>
        No variables
      </p>
    );
  }
  return (
    <>
      {state.variables.map((v, i) => (
        <VariableRow key={`${v.name}:${i}`} variable={v} depth={depth} />
      ))}
    </>
  );
}

/** Watches render first in the variables tree, like an IDE's inline watches. */
function WatchRows() {
  const watches = useDebug((s) => s.watches);
  const results = useDebug((s) => s.watchResults);
  const paused = useDebug((s) => s.phase === "paused");
  return (
    <>
      {watches.map((expr) => {
        const r = results[expr];
        const value = !paused ? "not available" : !r || r.status === "loading" ? "…" : r.status === "error" ? r.message : r.value;
        return (
          <div
            key={expr}
            role="treeitem"
            aria-level={1}
            aria-selected={false}
            aria-label={`${expr} = ${value}`}
            className="group flex h-[26px] items-center gap-1.5 pl-2 pr-1 font-mono text-[13px] hover:bg-hover"
          >
            <Eye className="size-3.5 shrink-0 text-accent-ink" />
            <span className="shrink-0 text-fg">{expr}</span>
            <span className="shrink-0 text-fg-faint">=</span>
            <span
              className={cn("truncate", r?.status === "error" && "font-sans text-danger")}
              style={paused && r?.status === "ready" ? { color: valueColor(value) } : undefined}
              title={r?.status === "error" ? r.message : undefined}
            >
              {value}
            </span>
            <IconButton
              label={`Remove watch ${expr}`}
              size="sm"
              className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => useDebug.getState().removeWatch(expr)}
            >
              <X />
            </IconButton>
          </div>
        );
      })}
    </>
  );
}

function SectionTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
      {children}
      {extra}
    </div>
  );
}

function Variables() {
  const localsRef = useDebug((s) => s.stop?.frames[s.selectedFrame]?.localsRef ?? 0);
  const paused = useDebug((s) => s.phase === "paused");
  const [draft, setDraft] = useState("");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          useDebug.getState().addWatch(draft);
          setDraft("");
        }}
        className="mx-2 mt-2 flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line-strong bg-surface-2 pl-2.5 pr-1 focus-within:border-accent"
      >
        <Eye className="size-3.5 shrink-0 text-fg-subtle" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Evaluate an expression or add a watch"
          aria-label="Add watch expression"
          maxLength={500}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle"
        />
        <button type="submit" disabled={!draft.trim()} aria-label="Add watch" className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-fg-subtle hover:bg-hover hover:text-fg disabled:opacity-40">
          <Plus className="size-3.5" /> Watch
        </button>
      </form>
      <div role="tree" aria-label="Variables" className="min-h-0 flex-1 overflow-auto pb-1 pt-1">
        <WatchRows />
        {!paused ? (
          <p className="px-3 py-1 text-sm text-fg-subtle">Variables are shown while the program is paused.</p>
        ) : !localsRef ? (
          <p className="px-3 py-1 text-sm text-fg-subtle">No variables for this frame.</p>
        ) : (
          <VariableChildren parentRef={localsRef} depth={0} />
        )}
      </div>
    </div>
  );
}

function splitName(f: DebugFrame): { method: string; owner: string } {
  const dot = f.name.lastIndexOf(".");
  const method = dot === -1 ? f.name : f.name.slice(dot + 1);
  const cls = dot === -1 ? "" : f.name.slice(0, dot);
  // Java frames name their class; Python functions fall back to the file name.
  return { method, owner: cls ? cls.slice(cls.lastIndexOf(".") + 1) : f.file ? basename(f.file) : "" };
}

function Frames({ stop }: { stop: StopInfo | null }) {
  const selected = useDebug((s) => s.selectedFrame);
  const [showLibrary, setShowLibrary] = useState(false);
  const frames = stop?.frames ?? [];
  const library = frames.filter((f) => !f.file).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionTitle
        extra={
          stop && (
            <span className="ml-auto flex items-center gap-1.5 rounded-full bg-warning-soft px-2 py-px font-sans text-[10.5px] font-medium normal-case tracking-normal text-warning">
              <span className="size-1.5 rounded-full bg-warning" />“{stop.thread}”: PAUSED
            </span>
          )
        }
      >
        Call stack
      </SectionTitle>
      <ul aria-label="Call stack" className="min-h-0 flex-1 space-y-0.5 overflow-auto px-1.5 pb-1.5">
        {frames.map((f, i) => {
          if (!f.file && !showLibrary && i !== selected) return null;
          const { method, owner } = splitName(f);
          const current = i === selected;
          return (
            <li key={f.id}>
              <button
                aria-label={`${method}:${f.line}${owner ? `, ${owner}` : ""}`}
                aria-current={current || undefined}
                onClick={() => {
                  useDebug.getState().selectFrame(i);
                  if (f.file) goToLocation(f.file, f.line);
                }}
                className={cn(
                  "relative flex w-full items-center gap-2 rounded-md py-1 pl-3 pr-2 text-left transition-colors",
                  current ? "bg-accent-soft/70 text-fg" : "hover:bg-hover",
                  !f.file && "opacity-60",
                )}
              >
                {current && <span className="absolute inset-y-1 left-0.5 w-[3px] rounded-full bg-accent" />}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5 font-mono text-[13px]">
                  <span className={cn("truncate", current ? "font-semibold" : "text-fg")}>{method}</span>
                  {owner && <span className="truncate text-[12px] text-fg-subtle">{owner}</span>}
                </span>
                <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-fg-subtle">
                  {f.file ? `${basename(f.file)}:${f.line}` : `line ${f.line}`}
                </span>
              </button>
            </li>
          );
        })}
        {library > 0 && (
          <li>
            <button onClick={() => setShowLibrary(!showLibrary)} className="w-full rounded-md px-3 py-1 text-left text-[12px] text-fg-subtle hover:bg-hover hover:text-fg">
              {showLibrary ? "Hide" : "Show"} {library} library frame{library === 1 ? "" : "s"}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Where the program is paused and what changed since the last pause. */
function WhereBar({ stop }: { stop: StopInfo }) {
  const selected = useDebug((s) => s.selectedFrame);
  const frame = stop.frames[selected];
  const localsRef = frame?.localsRef ?? 0;
  const locals = useDebug((s) => s.variables[localsRef]);
  const previous = useDebug((s) => (s.previous?.frame === frameKey(stop.frames, selected) ? s.previous.values : null));
  if (!frame) return null;
  const { method } = splitName(frame);
  const changes =
    previous && locals?.status === "ready"
      ? locals.variables.filter((v) => previous[v.name] !== undefined && previous[v.name] !== v.value).map((v) => ({ name: v.name, from: previous[v.name]!, to: v.value }))
      : [];
  return (
    <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2/40 px-3 py-1.5 text-[12.5px]">
      <span className="flex items-center gap-1.5 text-fg">
        <Pause className="size-3.5 fill-current text-warning" />
        Paused in <code className="rounded bg-hover px-1 font-mono text-[12px]">{method}</code>
        {frame.file && (
          <>
            at
            <button onClick={() => goToLocation(frame.file!, frame.line)} className="font-mono text-[12px] text-accent-ink hover:underline">
              {basename(frame.file)}:{frame.line}
            </button>
          </>
        )}
      </span>
      {changes.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-fg-subtle" aria-label="Changed since the last pause">
          Changed:
          {changes.slice(0, 4).map((c) => (
            <span key={c.name} className="cw-viz-changed rounded-md px-1.5 font-mono text-[12px] text-fg">
              {c.name} <span className="text-fg-subtle">{shortValue(c.from, 16)} →</span> {shortValue(c.to, 16)}
            </span>
          ))}
          {changes.length > 4 && <span>+{changes.length - 4} more</span>}
        </span>
      )}
    </div>
  );
}

/** Before the first pause: one line saying what is happening. */
function StartingView({ running }: { running: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      {running ? (
        <p className="max-w-md text-sm text-fg-subtle">The program is running. It pauses at your breakpoints; press Pause to stop it wherever it is.</p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-fg-subtle">
          <Spinner /> Starting…
        </p>
      )}
    </div>
  );
}

function BreakpointsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const project = useWorkspace((s) => s.project);
  const touch = useMediaQuery(COMPACT_QUERY);
  const unverified = useDebug((s) => s.unverified);
  const entries = Object.entries(project?.breakpoints ?? {}).flatMap(([file, lines]) => lines.map((line) => ({ file, line })));
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Breakpoints"
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" disabled={entries.length === 0} onClick={() => runCommand("debug.clearBreakpoints")}>
            Remove all
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-fg-subtle">
          No breakpoints. {touch ? "Tap the gutter next to a line number to add one." : <>Click the gutter next to a line number or press <Kbd shortcut="F9" />.</>}
        </p>
      ) : (
        <ul aria-label="Breakpoints" className="max-h-72 overflow-auto rounded-lg border border-line-strong bg-surface-2 py-1">
          {entries.map(({ file, line }) => {
            const text = project?.files.find((f) => f.path === file)?.content.split("\n")[line - 1]?.trim() ?? "";
            const isUnverified = unverified[file]?.includes(line);
            return (
              <li key={`${file}:${line}`} className="group flex h-8 items-center gap-2 pl-2.5 pr-1 text-sm hover:bg-hover">
                <CircleDot className={cn("size-3.5 shrink-0", isUnverified ? "text-fg-subtle" : "text-danger")} />
                <button
                  onClick={() => {
                    onOpenChange(false);
                    goToLocation(file, line);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={isUnverified ? "Not set: no executable code on this line" : undefined}
                >
                  <span className="shrink-0 font-mono text-[12.5px] text-fg">
                    {basename(file)}:{line}
                  </span>
                  <span className="truncate font-mono text-xs text-fg-subtle">{text}</span>
                </button>
                <IconButton label={`Remove breakpoint ${basename(file)}:${line}`} size="sm" onClick={() => useWorkspace.getState().toggleBreakpoint(file, line)}>
                  <X />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

const reasonLabel: Record<StopInfo["reason"], string> = {
  breakpoint: "Paused on breakpoint",
  step: "Paused after step",
  pause: "Paused",
  exception: "Paused on exception",
  entry: "Paused on entry",
};

/** Debug tool window (bottom), with a controls toolbar and Threads & Variables / Console tabs. */
export function DebugToolWindow() {
  const phase = useDebug((s) => s.phase);
  const stop = useDebug((s) => s.stop);
  const run = useExecution((s) => s.run);
  const language = useWorkspace((s) => (s.project ? getLanguage(s.project.language) : undefined));
  const breakpointCount = useWorkspace((s) => Object.values(s.project?.breakpoints ?? {}).reduce((n, lines) => n + lines.length, 0));
  const [tab, setTab] = useState<"frames" | "console">("frames");
  const [breakpointsOpen, setBreakpointsOpen] = useState(false);
  const active = run?.mode === "debug" && isOwnRun(run);
  const paused = active && phase === "paused";
  const supported = canDebug();

  // When a session ends, show its console so the program's output and exit code are visible.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active && run?.mode === "debug") setTab("console");
    if (active) setTab("frames");
  }

  // Show the console (and its input bar) while the program waits for typed input, and the frames when it pauses.
  const waiting = active && run?.status === "WAITING_FOR_INPUT";
  const [shown, setShown] = useState({ waiting, paused });
  if (shown.waiting !== waiting || shown.paused !== paused) {
    setShown({ waiting, paused });
    if (waiting && !shown.waiting) setTab("console");
    else if (paused && !shown.paused) setTab("frames");
  }

  let status: string;
  let tone: "paused" | "running" | "starting" | "idle";
  if (paused && stop) [status, tone] = [reasonLabel[stop.reason], "paused"];
  else if (active && phase === "running") [status, tone] = ["Running", "running"];
  else if (active) [status, tone] = [run.status === "COMPILING" ? "Compiling…" : "Starting…", "starting"];
  else [status, tone] = ["Not running", "idle"];

  const tool = (id: string, label: string, icon: ReactNode, enabled: boolean, className?: string) => (
    <IconButton label={label} shortcut={primaryShortcut(id)} disabled={!enabled} onClick={() => runCommand(id)} className={className}>
      {icon}
    </IconButton>
  );

  return (
    <aside aria-label="Debugger" className="@container/dbg flex h-full min-h-0 flex-col">
      <div role="toolbar" aria-label="Debug controls" className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 @max-[640px]/dbg:gap-y-1.5 @max-[640px]/dbg:py-1.5">
        {tool("debug.restart", "Restart", <RotateCw />, active, "text-success")}
        {tool("run.cancel", "Stop", <Square className={cn(active && "fill-current")} />, active, cn(active && "text-danger"))}
        <span className="mx-1 h-5 w-px bg-line-strong" />
        {paused ? (
          <button
            type="button"
            aria-label="Continue"
            title={`Continue (${primaryShortcut("debug.startOrContinue") ?? "F5"})`}
            onClick={() => runCommand("debug.startOrContinue")}
            className="flex h-7 items-center gap-1.5 rounded-full bg-success px-3 text-[12.5px] font-medium text-white transition-transform hover:brightness-110 active:scale-95"
          >
            <Play className="size-3.5 fill-current" /> Continue
          </button>
        ) : active && phase === "running" ? (
          <button
            type="button"
            aria-label="Pause"
            title={`Pause (${primaryShortcut("debug.pause") ?? "F6"})`}
            onClick={() => runCommand("debug.pause")}
            className="flex h-7 items-center gap-1.5 rounded-full bg-warning px-3 text-[12.5px] font-medium text-black/80 transition-transform hover:brightness-110 active:scale-95"
          >
            <Pause className="size-3.5 fill-current" /> Pause
          </button>
        ) : (
          tool("debug.startOrContinue", "Resume Program", <Play />, false)
        )}
        <div className="ml-1 flex items-center rounded-lg bg-surface-2 p-0.5" aria-label="Stepping">
          {tool("debug.stepOver", "Step Over", <Redo2 />, paused)}
          {tool("debug.stepIn", "Step Into", <ArrowDownToDot />, paused)}
          {tool("debug.stepOut", "Step Out", <ArrowUpFromDot />, paused)}
        </div>
        <span className="mx-1 h-5 w-px bg-line-strong" />
        <button
          type="button"
          aria-label="View Breakpoints"
          title="View Breakpoints"
          onClick={() => setBreakpointsOpen(true)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
        >
          <CircleDot className="size-4 text-danger" />
          {breakpointCount > 0 && <span className="tabular-nums">{breakpointCount}</span>}
        </button>
        <div role="tablist" className="ml-2 flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
          {(
            [
              ["frames", "Variables"],
              ["console", "Console"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn("whitespace-nowrap rounded-md px-2.5 py-1 text-[12.5px] transition-colors", tab === id ? "bg-canvas text-fg shadow-sm" : "text-fg-subtle hover:text-fg")}
            >
              {/* The full name where it fits. */}
              {id === "frames" && <span className="@max-[640px]/dbg:hidden">Threads &amp; </span>}
              {label}
            </button>
          ))}
        </div>
        {/* No pill while idle: the empty view already says how to start. */}
        {tone !== "idle" && <span
          className={cn(
            "ml-auto flex items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-[12px]",
            tone === "paused" && "bg-warning-soft text-fg",
            tone === "running" && "bg-success-soft text-fg",
            tone === "starting" && "bg-accent-soft/60 text-fg",
          )}
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              tone === "paused" && "bg-warning",
              tone === "running" && "animate-pulse bg-success",
              tone === "starting" && "animate-pulse bg-accent",
            )}
          />
          {status}
        </span>}
      </div>

      {!supported ? (
        <p className="p-3 text-sm text-fg-subtle">Debugging is not available for {language?.name ?? "this language"}. It supports Java, Kotlin, Python, C, C++, JavaScript and TypeScript.</p>
      ) : tab === "console" ? (
        <div className="min-h-0 flex-1">
          <ConsoleView />
        </div>
      ) : (
        <>
          {paused && stop?.reason === "exception" && stop.description && (
            <div role="alert" className="flex shrink-0 items-start gap-2.5 border-b border-danger/30 bg-danger-soft px-3 py-2 text-sm text-fg">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
              <span className="break-words font-mono text-[12.5px]">{stop.description}</span>
            </div>
          )}
          {paused && stop && <WhereBar stop={stop} />}
          {!active && phase !== "paused" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-sm text-fg-subtle">
              <CircleDot className="size-6 text-danger/70" />
              <p className="max-w-md">
                <span className="[@media(pointer:coarse)]:hidden">Click</span><span className="hidden [@media(pointer:coarse)]:inline">Tap</span> next to a line number to add a breakpoint, then start debugging.
              </p>
              <Button variant="primary" onClick={() => runCommand("debug.startOrContinue")}>
                Start debugging
              </Button>
            </div>
          ) : !paused ? (
            <StartingView running={phase === "running"} />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="w-[38%] min-w-52 max-w-[26rem] border-r border-line">
                <Frames stop={stop} />
              </div>
              <div className="min-w-0 flex-1">
                <Variables />
              </div>
            </div>
          )}
        </>
      )}
      <BreakpointsDialog open={breakpointsOpen} onOpenChange={setBreakpointsOpen} />
    </aside>
  );
}
