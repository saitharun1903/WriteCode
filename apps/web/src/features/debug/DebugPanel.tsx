"use client";

import { AlertTriangle, Bug, ChevronRight, CircleDot, Plus, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { basename, getLanguage, type DebugVariable } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { PanelHeader, Spinner } from "@/components/ui/primitives";
import { canDebug, runCommand } from "@/features/commands/registry";
import { goToLocation } from "@/features/editor/navigate";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { useDebug, type StopInfo } from "./store";

function Section({ title, count, actions, children, defaultOpen = true }: { title: string; count?: number; actions?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-t border-line first:border-t-0">
      <div className="group flex h-7 items-center pr-1.5">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-full flex-1 items-center gap-1 pl-2 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle hover:text-fg-muted"
        >
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
          {title}
          {count !== undefined && count > 0 && <span className="ml-1 rounded-sm bg-surface-3 px-1 font-normal tracking-normal">{count}</span>}
        </button>
        {actions && <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{actions}</div>}
      </div>
      {open && <div className="pb-2">{children}</div>}
    </section>
  );
}

function valueClass(v: Pick<DebugVariable, "value" | "type">): string {
  if (v.value === "null") return "text-fg-subtle";
  if (v.value.startsWith('"') || v.value.startsWith("'")) return "text-[#8fd18f]";
  if (/^-?\d/.test(v.value) || v.value === "true" || v.value === "false") return "text-[#f0b674]";
  return "text-fg-muted";
}

/** One variable row; expandable values load their children on first open. */
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
        title={`${variable.name}: ${variable.type}`}
        className="flex h-[22px] items-center gap-1 pr-2 font-mono text-xs hover:bg-hover focus-visible:bg-hover"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {expandable ? (
          <ChevronRight className={cn("size-3 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 text-[#9cc3ff]">{variable.name}</span>
        <span className="shrink-0 text-fg-faint">=</span>
        <span className={cn("truncate", valueClass(variable))}>{variable.value}</span>
      </div>
      {open && expandable && <VariableChildren parentRef={variable.ref} depth={depth + 1} />}
    </>
  );
}

function VariableChildren({ parentRef, depth }: { parentRef: number; depth: number }) {
  const state = useDebug((s) => s.variables[parentRef]);
  if (!state || state.status === "loading") {
    return (
      <div className="flex h-[22px] items-center gap-2 text-xs text-fg-subtle" style={{ paddingLeft: 8 + depth * 12 + 16 }}>
        <Spinner className="size-3" /> Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <p className="py-1 pr-2 text-xs text-danger" style={{ paddingLeft: 8 + depth * 12 + 16 }}>
        {state.message}
      </p>
    );
  }
  if (state.variables.length === 0) {
    return (
      <p className="py-0.5 text-xs text-fg-subtle" style={{ paddingLeft: 8 + depth * 12 + 16 }}>
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

function Variables() {
  const localsRef = useDebug((s) => s.stop?.frames[s.selectedFrame]?.localsRef ?? 0);
  const paused = useDebug((s) => s.phase === "paused");
  if (!paused) return <p className="px-4 py-1 text-xs text-fg-subtle">Available while paused.</p>;
  if (!localsRef) return <p className="px-4 py-1 text-xs text-fg-subtle">No variables for this frame.</p>;
  return (
    <div role="tree" aria-label="Variables">
      <VariableChildren parentRef={localsRef} depth={0} />
    </div>
  );
}

function Watch() {
  const watches = useDebug((s) => s.watches);
  const results = useDebug((s) => s.watchResults);
  const paused = useDebug((s) => s.phase === "paused");
  const [draft, setDraft] = useState("");

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          useDebug.getState().addWatch(draft);
          setDraft("");
        }}
        className="mx-2 mb-1 flex items-center gap-1"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add expression, e.g. count * 2"
          aria-label="Add watch expression"
          maxLength={500}
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded-sm border border-line bg-surface px-1.5 font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-fg-faint focus:border-accent-line"
        />
        <IconButton type="submit" label="Add watch" size="sm" disabled={!draft.trim()}>
          <Plus />
        </IconButton>
      </form>
      {watches.map((expr) => {
        const r = results[expr];
        return (
          <div key={expr} className="group flex min-h-[22px] items-center gap-1 pl-4 pr-1 font-mono text-xs hover:bg-hover">
            <span className="shrink-0 text-fg">{expr}</span>
            <span className="shrink-0 text-fg-faint">=</span>
            {!paused ? (
              <span className="truncate font-sans text-fg-subtle">not available</span>
            ) : !r || r.status === "loading" ? (
              <Spinner className="size-3 text-fg-subtle" />
            ) : r.status === "error" ? (
              <span className="truncate font-sans text-danger" title={r.message}>
                {r.message}
              </span>
            ) : (
              <span className={cn("truncate", valueClass(r))} title={r.type}>
                {r.value}
              </span>
            )}
            <IconButton
              label={`Remove ${expr}`}
              size="sm"
              className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => useDebug.getState().removeWatch(expr)}
            >
              <X />
            </IconButton>
          </div>
        );
      })}
      {watches.length === 0 && <p className="px-4 text-xs text-fg-subtle">Expressions support variables, fields, array indexing and arithmetic.</p>}
    </div>
  );
}

function CallStack({ stop }: { stop: StopInfo | null }) {
  const selected = useDebug((s) => s.selectedFrame);
  if (!stop) return <p className="px-4 py-1 text-xs text-fg-subtle">Available while paused.</p>;
  return (
    <ul aria-label="Call stack">
      {stop.frames.map((f, i) => {
        const own = !!f.file;
        return (
          <li key={f.id}>
            <button
              onClick={() => {
                useDebug.getState().selectFrame(i);
                if (f.file) goToLocation(f.file, f.line);
              }}
              className={cn(
                "flex h-[22px] w-full items-center gap-2 px-4 text-left text-xs hover:bg-hover",
                i === selected && "bg-active",
                !own && "text-fg-faint",
              )}
            >
              <span className={cn("truncate font-mono", own ? "text-fg" : "text-fg-faint")}>{f.name}()</span>
              <span className="ml-auto shrink-0 text-2xs text-fg-subtle">{f.file ? `${basename(f.file)}:${f.line}` : "JDK"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Breakpoints() {
  const project = useWorkspace((s) => s.project);
  const unverified = useDebug((s) => s.unverified);
  const entries = Object.entries(project?.breakpoints ?? {}).flatMap(([file, lines]) => lines.map((line) => ({ file, line })));
  if (entries.length === 0) {
    return (
      <p className="px-4 text-xs text-fg-subtle">
        Click left of a line number or press <Kbd shortcut="F9" /> to add one.
      </p>
    );
  }
  return (
    <ul aria-label="Breakpoints">
      {entries.map(({ file, line }) => {
        const text = project?.files.find((f) => f.path === file)?.content.split("\n")[line - 1]?.trim() ?? "";
        const isUnverified = unverified[file]?.includes(line);
        return (
          <li key={`${file}:${line}`} className="group flex h-[22px] items-center gap-2 pl-4 pr-1 text-xs hover:bg-hover">
            <CircleDot className={cn("size-3 shrink-0", isUnverified ? "text-fg-subtle" : "text-danger")} />
            <button onClick={() => goToLocation(file, line)} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={isUnverified ? "Not set: no executable code on this line" : undefined}>
              <span className="shrink-0 text-fg">
                {basename(file)}:{line}
              </span>
              <span className="truncate font-mono text-fg-subtle">{text}</span>
            </button>
            <IconButton
              label={`Remove breakpoint ${basename(file)}:${line}`}
              size="sm"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => useWorkspace.getState().toggleBreakpoint(file, line)}
            >
              <X />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

const reasonLabel: Record<StopInfo["reason"], string> = {
  breakpoint: "Paused on breakpoint",
  step: "Paused after step",
  pause: "Paused",
  exception: "Paused on exception",
  entry: "Paused on entry",
};

export function DebugPanel() {
  const phase = useDebug((s) => s.phase);
  const stop = useDebug((s) => s.stop);
  const run = useExecution((s) => s.run);
  const language = useWorkspace((s) => (s.project ? getLanguage(s.project.language) : undefined));
  const watchCount = useDebug((s) => s.watches.length);
  const bpCount = useWorkspace((s) => Object.values(s.project?.breakpoints ?? {}).reduce((n, l) => n + l.length, 0));
  const active = run?.mode === "debug" && isRunning(run);
  const supported = canDebug();

  let status: ReactNode;
  if (active && phase === "paused" && stop) status = <span className="text-warning">{reasonLabel[stop.reason]}</span>;
  else if (active && (phase === "starting" || run.status === "COMPILING" || run.status === "QUEUED" || run.status === "SUBMITTING")) {
    status = (
      <span className="flex items-center gap-1.5 text-fg-subtle">
        <Spinner className="size-3" /> {run.status === "COMPILING" ? "Compiling…" : "Starting…"}
      </span>
    );
  } else if (active) status = <span className="text-success">Running</span>;
  else status = <span className="text-fg-subtle">Not running</span>;

  return (
    <aside aria-label="Debugger" className="flex h-full min-h-0 flex-col bg-surface">
      <PanelHeader
        title="Debug"
        actions={
          <IconButton label="Close debug panel" size="sm" onClick={() => runCommand("view.debug")}>
            <X />
          </IconButton>
        }
      />
      <div className="flex min-h-8 shrink-0 items-center gap-2 px-3 pb-2 text-xs">{status}</div>

      {!supported ? (
        <div className="px-3 text-xs leading-relaxed text-fg-subtle">
          <p>
            Debugging is not available for {language?.name ?? "this language"} yet. It currently supports Java, where it pauses the real JVM through JDWP.
          </p>
        </div>
      ) : (
        <>
          {!active && (
            <div className="px-3 pb-3">
              <Button variant="primary" className="w-full" icon={<Bug className="size-3.5" />} onClick={() => runCommand("debug.startOrContinue")}>
                Start debugging
              </Button>
              <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-fg-subtle">
                <Kbd shortcut="F5" /> start · <Kbd shortcut="F9" /> breakpoint · <Kbd shortcut="F10" /> step over · <Kbd shortcut="F11" /> step into
              </p>
            </div>
          )}
          {stop?.reason === "exception" && stop.description && (
            <div role="alert" className="mx-3 mb-2 flex gap-2 rounded-md border border-danger/30 bg-danger-soft p-2 text-xs text-danger">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span className="break-words">{stop.description}</span>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Section title="Variables">
              <Variables />
            </Section>
            <Section title="Watch" count={watchCount}>
              <Watch />
            </Section>
            <Section title="Call Stack">
              <CallStack stop={active ? stop : null} />
            </Section>
            <Section
              title="Breakpoints"
              count={bpCount}
              actions={
                bpCount > 0 && (
                  <IconButton label="Remove all breakpoints" size="sm" onClick={() => runCommand("debug.clearBreakpoints")}>
                    <Trash2 />
                  </IconButton>
                )
              }
            >
              <Breakpoints />
            </Section>
          </div>
        </>
      )}
    </aside>
  );
}
