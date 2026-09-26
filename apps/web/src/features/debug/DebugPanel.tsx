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
  Redo2,
  RotateCw,
  Square,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { basename, getLanguage, type DebugVariable } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/primitives";
import { canDebug, primaryShortcut, runCommand } from "@/features/commands/registry";
import { goToLocation } from "@/features/editor/navigate";
import { ConsoleView } from "@/features/execution/OutputPanel";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { useDebug, type StopInfo } from "./store";

const INDENT = 16;

function valueClass(value: string): string {
  if (value === "null") return "text-[#cf8e6d]";
  if (value.startsWith('"') || value.startsWith("'")) return "text-[#6aab73]";
  if (/^-?\d/.test(value) || value === "true" || value === "false") return "text-[#2aacb8]";
  return "text-fg-subtle";
}

/** Variable row. Expandable values load their children on first open. */
function VariableRow({ variable, depth }: { variable: DebugVariable; depth: number }) {
  const [open, setOpen] = useState(false);
  const children = useDebug((s) => (variable.ref ? s.variables[variable.ref] : undefined));
  const expandable = variable.ref > 0;

  const toggle = () => {
    if (!expandable) return;
    if (!open && !children) useDebug.getState().loadVariables(variable.ref);
    setOpen(!open);
  };

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
        title={variable.type}
        className="flex h-[22px] items-center gap-1.5 pr-2 font-mono text-[13px] hover:bg-hover focus-visible:bg-accent-soft"
        style={{ paddingLeft: 6 + depth * INDENT }}
      >
        {expandable ? (
          <ChevronRight className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <span className="shrink-0 text-fg">{variable.name}</span>
        <span className="shrink-0 text-fg-subtle">=</span>
        <span className={cn("truncate", valueClass(variable.value))}>{variable.value}</span>
      </div>
      {open && expandable && <VariableChildren parentRef={variable.ref} depth={depth + 1} />}
    </>
  );
}

function VariableChildren({ parentRef, depth }: { parentRef: number; depth: number }) {
  const state = useDebug((s) => s.variables[parentRef]);
  const pad = { paddingLeft: 6 + depth * INDENT + 20 };
  if (!state || state.status === "loading") {
    return (
      <div className="flex h-[22px] items-center gap-2 text-sm text-fg-subtle" style={pad}>
        <Spinner className="size-3" /> Collecting data…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="py-0.5 pr-2 text-sm text-danger" style={pad}>
        {state.message}
      </p>
    );
  }
  if (state.variables.length === 0) {
    return (
      <p className="py-0.5 text-sm text-fg-subtle" style={pad}>
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
            className="group flex h-[22px] items-center gap-1.5 pl-1.5 pr-1 font-mono text-[13px] hover:bg-hover"
          >
            <Eye className="size-3.5 shrink-0 text-fg-subtle" />
            <span className="shrink-0 text-fg">{expr}</span>
            <span className="shrink-0 text-fg-subtle">=</span>
            <span
              className={cn("truncate", !paused || r?.status === "loading" ? "text-fg-subtle" : r?.status === "error" ? "font-sans text-danger" : valueClass(value))}
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
        className="flex h-8 shrink-0 items-center border-b border-line px-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Evaluate expression or add a watch (Enter)"
          aria-label="Add watch expression"
          maxLength={500}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle"
        />
      </form>
      <div role="tree" aria-label="Variables" className="min-h-0 flex-1 overflow-auto py-0.5">
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

function Frames({ stop }: { stop: StopInfo | null }) {
  const selected = useDebug((s) => s.selectedFrame);
  const phase = useDebug((s) => s.phase);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-3 text-sm text-fg-subtle">
        {stop ? (
          <span className="truncate">
            “{stop.thread}”: <span className="text-fg">PAUSED</span>
          </span>
        ) : (
          <span className="truncate">{phase === "running" ? "“main”: RUNNING" : "Frames are not available"}</span>
        )}
      </div>
      <ul aria-label="Call stack" className="min-h-0 flex-1 overflow-auto py-0.5">
        {stop?.frames.map((f, i) => {
          const dot = f.name.lastIndexOf(".");
          const method = dot === -1 ? f.name : f.name.slice(dot + 1);
          const cls = dot === -1 ? "" : f.name.slice(0, dot);
          const simple = cls.slice(cls.lastIndexOf(".") + 1);
          return (
            <li key={f.id}>
              <button
                onClick={() => {
                  useDebug.getState().selectFrame(i);
                  if (f.file) goToLocation(f.file, f.line);
                }}
                className={cn(
                  "flex h-[22px] w-full items-center gap-1 px-3 text-left font-mono text-[13px] hover:bg-hover",
                  i === selected && "bg-accent-soft hover:bg-accent-soft",
                  !f.file && "text-fg-subtle",
                )}
              >
                <span className="truncate">
                  {method}:{f.line}, {simple}
                </span>
                {cls.includes(".") && <span className="truncate text-fg-subtle">({cls.slice(0, cls.lastIndexOf("."))})</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BreakpointsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const project = useWorkspace((s) => s.project);
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
          No breakpoints. Click the gutter next to a line number or press <Kbd shortcut="F9" />.
        </p>
      ) : (
        <ul aria-label="Breakpoints" className="max-h-72 overflow-auto rounded-[4px] border border-line-strong bg-surface-2 py-1">
          {entries.map(({ file, line }) => {
            const text = project?.files.find((f) => f.path === file)?.content.split("\n")[line - 1]?.trim() ?? "";
            const isUnverified = unverified[file]?.includes(line);
            return (
              <li key={`${file}:${line}`} className="group flex h-7 items-center gap-2 pl-2 pr-1 text-sm hover:bg-hover">
                <CircleDot className={cn("size-3.5 shrink-0", isUnverified ? "text-fg-subtle" : "text-danger")} />
                <button
                  onClick={() => {
                    onOpenChange(false);
                    goToLocation(file, line);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={isUnverified ? "Not set: no executable code on this line" : undefined}
                >
                  <span className="shrink-0 text-fg">
                    {basename(file)}:{line}
                  </span>
                  <span className="truncate font-mono text-xs text-fg-subtle">{text}</span>
                </button>
                <IconButton
                  label={`Remove breakpoint ${basename(file)}:${line}`}
                  size="sm"
                  onClick={() => useWorkspace.getState().toggleBreakpoint(file, line)}
                >
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
  const [tab, setTab] = useState<"frames" | "console">("frames");
  const [breakpointsOpen, setBreakpointsOpen] = useState(false);
  const active = run?.mode === "debug" && isRunning(run);
  const paused = active && phase === "paused";
  const supported = canDebug();

  // When a session ends, show its console so the program's output and exit code are visible.
  const [wasActive, setWasActive] = useState(active);
  if (wasActive !== active) {
    setWasActive(active);
    if (!active && run?.mode === "debug") setTab("console");
    if (active) setTab("frames");
  }

  let status: ReactNode;
  if (paused && stop) status = reasonLabel[stop.reason];
  else if (active && phase === "running") status = "Running";
  else if (active) status = run.status === "COMPILING" ? "Compiling…" : "Starting…";
  else status = "Not running";

  const tool = (id: string, label: string, icon: ReactNode, enabled: boolean, className?: string) => (
    <IconButton label={label} shortcut={primaryShortcut(id)} disabled={!enabled} onClick={() => runCommand(id)} className={className}>
      {icon}
    </IconButton>
  );

  return (
    <aside aria-label="Debugger" className="flex h-full min-h-0 flex-col">
      <div role="toolbar" aria-label="Debug controls" className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        {tool("debug.restart", "Restart", <RotateCw />, active, "text-success")}
        {tool("run.cancel", "Stop", <Square className={cn(active && "fill-current")} />, active, cn(active && "text-danger"))}
        <span className="mx-1 h-4 w-px bg-line-strong" />
        {paused
          ? tool("debug.startOrContinue", "Continue", <Play className="fill-current" />, true, "text-success")
          : tool("debug.startOrContinue", "Resume Program", <Play />, false)}
        {tool("debug.pause", "Pause", <Pause />, active && phase === "running")}
        <span className="mx-1 h-4 w-px bg-line-strong" />
        {tool("debug.stepOver", "Step Over", <Redo2 />, paused)}
        {tool("debug.stepIn", "Step Into", <ArrowDownToDot />, paused)}
        {tool("debug.stepOut", "Step Out", <ArrowUpFromDot />, paused)}
        <span className="mx-1 h-4 w-px bg-line-strong" />
        <IconButton label="View Breakpoints" className="text-danger" onClick={() => setBreakpointsOpen(true)}>
          <CircleDot />
        </IconButton>
        <div role="tablist" className="ml-3 flex h-full items-stretch">
          {(
            [
              ["frames", "Threads & Variables"],
              ["console", "Console"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn("relative px-2.5 text-sm", tab === id ? "text-fg" : "text-fg-subtle hover:text-fg")}
            >
              {label}
              {tab === id && <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent" />}
            </button>
          ))}
        </div>
        <span className={cn("ml-auto truncate pr-1 text-sm", paused ? "text-fg" : "text-fg-subtle")}>{status}</span>
      </div>

      {!supported ? (
        <p className="p-3 text-sm text-fg-subtle">
          Debugging is not available for {language?.name ?? "this language"} yet. It currently supports Java, where it pauses the real JVM
          through JDWP.
        </p>
      ) : tab === "console" ? (
        <div className="min-h-0 flex-1">
          <ConsoleView />
        </div>
      ) : (
        <>
          {paused && stop?.reason === "exception" && stop.description && (
            <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-soft px-3 py-1.5 text-sm text-fg">
              <AlertTriangle className="size-4 shrink-0 text-danger" />
              <span className="break-words">{stop.description}</span>
            </div>
          )}
          {!active && phase !== "paused" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-sm text-fg-subtle">
              <p>
                Set breakpoints in the gutter next to the line numbers (<Kbd shortcut="F9" />), then start debugging.
              </p>
              <Button variant="primary" onClick={() => runCommand("debug.startOrContinue")}>
                Start debugging
              </Button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="w-[38%] min-w-44 max-w-96 border-r border-line">
                <Frames stop={paused ? stop : null} />
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
