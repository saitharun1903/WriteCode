"use client";

import { ArrowDownToLine, Check, Copy, CornerDownLeft, FlaskConical, Keyboard, RotateCw, Search, Sparkles, Square, Trash2, WrapText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { runCommand, showBottom } from "@/features/commands/registry";
import { useWorkspace } from "@/features/projects/store";
import { useLastRunAsTest, useTests } from "@/features/tests/store";
import { TEST_LIMITS } from "@cw/shared";
import { cn } from "@/lib/cn";
import { STATUS_META } from "./status";
import { isRunning, useExecution, type LogChunk, type RunState } from "./store";

const streamClass: Record<LogChunk["stream"], string> = {
  stdout: "text-fg",
  stderr: "text-danger",
  compile: "text-danger",
  stdin: "text-success",
  system: "font-sans text-[12px] tracking-normal text-fg-subtle",
};

/**
 * Typed input for a running program. Shown while the program's stdin is open;
 * highlighted when the kernel reports the program blocked reading it.
 */
function ConsoleInput() {
  const run = useExecution((s) => s.run);
  const sendInput = useExecution((s) => s.sendInput);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const waiting = run?.status === "WAITING_FOR_INPUT";

  useEffect(() => {
    if (waiting) inputRef.current?.focus({ preventScroll: true });
  }, [waiting]);

  if (!run || !run.interactive || !isRunning(run) || run.error) return null;
  const accepting = !run.inputClosed && (run.status === "RUNNING" || run.status === "WAITING_FOR_INPUT");

  const send = (eof = false) => {
    if (!accepting) return;
    sendInput(eof ? value : `${value}\n`, eof);
    setValue("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 border-t px-2 transition-colors",
        waiting ? "border-warning/60 bg-warning-soft" : "border-line bg-surface-2",
      )}
    >
      <Keyboard className={cn("size-4 shrink-0", waiting ? "text-warning" : "text-fg-subtle")} />
      <span className={cn("hidden shrink-0 text-sm sm:inline", waiting ? "font-medium text-fg" : "text-fg-subtle")} aria-live="polite">
        {run.inputClosed ? "Input closed" : waiting ? "Program waiting for input" : "Input"}
      </span>
      <input
        ref={inputRef}
        value={value}
        disabled={!accepting}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "d" && e.ctrlKey) {
            e.preventDefault();
            send(true);
          }
        }}
        aria-label="Program input"
        placeholder={run.inputClosed ? "" : "Type input and press Enter"}
        spellCheck={false}
        autoComplete="off"
        className="h-7 min-w-0 flex-1 rounded-[5px] border border-line-strong bg-surface-2 px-2 font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle focus:border-accent disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!accepting}
        className="flex h-7 shrink-0 items-center gap-1 rounded-[5px] bg-accent px-2.5 text-sm font-medium text-accent-fg hover:brightness-110 disabled:opacity-45"
      >
        <CornerDownLeft className="size-3.5" />
        Send
      </button>
      <button
        type="button"
        disabled={!accepting}
        onClick={() => send(true)}
        title="Close the program's input (Ctrl+D)"
        className="h-7 shrink-0 rounded-[5px] px-2 text-sm text-fg-muted hover:bg-hover disabled:opacity-45"
      >
        Send EOF
      </button>
      {run.inputError && <span className="truncate text-xs text-danger">{run.inputError}</span>}
    </form>
  );
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  for (let hit = lower.indexOf(q); hit !== -1; hit = lower.indexOf(q, i)) {
    if (hit > i) out.push(text.slice(i, hit));
    out.push(
      <mark key={hit} className="rounded-[2px] bg-warning/40 text-fg">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    i = hit + q.length;
  }
  out.push(text.slice(i));
  return out;
}

/** Keeps a successful run's input and output as a test, to re-check after later changes. */
function SaveAsTest() {
  const lastRun = useLastRunAsTest();
  const saved = useWorkspace((s) => !!lastRun && !!s.project?.tests?.some((t) => t.input === lastRun.input && t.expected === lastRun.expected));
  const count = useWorkspace((s) => s.project?.tests?.length ?? 0);
  if (!lastRun) return null;
  return saved ? (
    <button type="button" onClick={() => showBottom("tests")} className="ml-3 inline-flex items-center gap-1 rounded-full border border-success/50 px-2 font-sans text-xs text-success hover:bg-success-soft">
      <Check className="size-3" /> Saved as a test
    </button>
  ) : (
    <button
      type="button"
      disabled={count >= TEST_LIMITS.maxTests}
      onClick={() => useTests.getState().add(lastRun)}
      className="ml-3 inline-flex items-center gap-1 rounded-full border border-line-strong px-2 font-sans text-xs text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      <FlaskConical className="size-3" /> Save as test
    </button>
  );
}

/** Closing line printed after the program ends, in the style of an IDE run console. */
function Epilogue({ run }: { run: RunState }) {
  const r = run.result;
  if (!r) return null;
  let line: ReactNode;
  switch (r.status) {
    case "SUCCESS":
    case "RUNTIME_ERROR":
      line = <span className="text-fg-subtle">Process finished with exit code {r.exitCode ?? "unknown"}</span>;
      break;
    case "COMPILATION_ERROR":
      line = <span className="text-danger">{r.message ?? `Compilation failed${r.exitCode !== undefined ? ` (exit code ${r.exitCode})` : ""}`}</span>;
      break;
    case "CANCELLED":
      line = <span className="text-fg-subtle">{r.message ?? "Process stopped"}</span>;
      break;
    case "SYSTEM_ERROR":
      line = <span className="text-danger">{r.message ?? STATUS_META.SYSTEM_ERROR.hint}</span>;
      break;
    default:
      line = <span className="text-warning">{r.message ?? STATUS_META[r.status].hint}</span>;
  }
  const failed = r.status !== "SUCCESS" && r.status !== "CANCELLED";
  return (
    <div className="mt-[20px]">
      {line}
      <SaveAsTest />
      {failed && (
        <button
          type="button"
          onClick={() => runCommand("assistant.explainError")}
          className="ml-3 inline-flex items-center gap-1 rounded-full border border-[#8a7cf5]/60 px-2 font-sans text-xs text-fg hover:bg-[#8a7cf5]/15"
        >
          <Sparkles className="size-3 text-[#8a7cf5]" /> Fix with AI
        </button>
      )}
    </div>
  );
}

/** Scrollable console output of the current run or debug session. */
export function ConsoleView({ query = "", wrap = true, follow = true }: { query?: string; wrap?: boolean; follow?: boolean }) {
  const run = useExecution((s) => s.run);
  const runner = useExecution((s) => s.runner);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const running = isRunning(run);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [run?.log, run?.result, follow]);

  return (
    <div className="flex h-full min-h-0 flex-col">
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="min-h-0 flex-1 overflow-auto bg-surface-2"
      role="log"
      aria-live="polite"
      aria-label="Program output"
    >
      {!run && (
        <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-fg-subtle">
          {runner === "offline" ? (
            <>
              <p>The execution service is not reachable.</p>
              <p>{process.env.NODE_ENV === "production" ? "Check your connection and try again." : "Start it with pnpm dev, see the README."}</p>
            </>
          ) : (
            <p className="flex items-center gap-1.5">
              Run the program with <Kbd shortcut="Mod+Enter" /> or debug it with <Kbd shortcut="F5" />
            </p>
          )}
        </div>
      )}

      {run && (
        <div
          className={cn(
            "cw-console px-3.5 py-2.5 font-mono text-[13.5px] leading-[22px]",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {run.log.map((chunk, i) => (
            <span key={i} className={streamClass[chunk.stream]}>
              {chunk.stream === "system" ? chunk.text : highlight(chunk.text, query)}
            </span>
          ))}
          {run.error && (
            <div role="alert" className="font-sans">
              <p className="text-danger">{run.error.title}</p>
              {run.error.detail && <p className="text-fg-subtle">{run.error.detail}</p>}
              {run.error.requestId && <p className="font-mono text-xs text-fg-faint">Request ID: {run.error.requestId}</p>}
              <button onClick={() => runCommand("run.execute")} className="mt-1 text-accent hover:underline">
                Retry
              </button>
            </div>
          )}
          {!run.error && <Epilogue run={run} />}
          {running && (run.status === "SUBMITTING" || run.status === "QUEUED" || run.status === "STARTING" || run.status === "COMPILING") && (
            <span className="text-fg-subtle">{run.status === "COMPILING" ? "Compiling…" : run.status === "QUEUED" ? "Waiting for a free sandbox…" : "Starting…"}</span>
          )}
        </div>
      )}
    </div>
    <ConsoleInput />
    </div>
  );
}

function formatMs(ms?: number) {
  if (ms === undefined) return null;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Run metrics shown in the tool window header, e.g. "compile 490 ms · run 732 ms · 22 MB". */
export function RunMetrics() {
  const r = useExecution((s) => s.run?.result);
  if (!r) return null;
  const parts = [
    r.queueTime !== undefined && `queue ${formatMs(r.queueTime)}`,
    r.startupTime !== undefined && `sandbox ${formatMs(r.startupTime)}`,
    r.compileTime !== undefined && `compile ${formatMs(r.compileTime)}`,
    r.executionTime !== undefined && `run ${formatMs(r.executionTime)}`,
    r.memoryUsed !== undefined && `${(r.memoryUsed / 1024 / 1024).toFixed(1)} MB`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <span className="hidden truncate text-xs text-fg-subtle md:inline">{parts.join(" · ")}</span>;
}

/** Run tool window: vertical action toolbar plus the console. */
export function RunToolWindow() {
  const run = useExecution((s) => s.run);
  const running = isRunning(run);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);

  const plainText = useMemo(() => run?.log.filter((c) => c.stream !== "system").map((c) => c.text).join("") ?? "", [run?.log]);
  const matchCount = useMemo(() => {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = plainText.toLowerCase();
    let n = 0;
    for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) n++;
    return n;
  }, [plainText, query]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <div className="flex h-full min-h-0">
      <div role="toolbar" aria-label="Run actions" aria-orientation="vertical" className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-r border-line py-1">
        <IconButton
          label={run?.mode === "debug" ? "Rerun in debugger" : "Rerun"}
          shortcut={run?.mode === "debug" ? "F5" : "Mod+Enter"}
          tooltipSide="right"
          disabled={running}
          className="text-success"
          onClick={() => runCommand(run?.mode === "debug" ? "debug.startOrContinue" : "run.execute")}
        >
          <RotateCw />
        </IconButton>
        <IconButton label="Stop" shortcut="Shift+F5" tooltipSide="right" disabled={!running} className={cn(running && "text-danger")} onClick={() => runCommand("run.cancel")}>
          <Square className={cn(running && "fill-current")} />
        </IconButton>
        <span className="my-1 h-px w-5 bg-line-strong" />
        <IconButton label="Soft-wrap" tooltipSide="right" active={wrap} onClick={() => setWrap((v) => !v)}>
          <WrapText />
        </IconButton>
        <IconButton label="Scroll to end" tooltipSide="right" active={follow} onClick={() => setFollow((v) => !v)}>
          <ArrowDownToLine />
        </IconButton>
        <IconButton label="Find in output" tooltipSide="right" active={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
          <Search />
        </IconButton>
        <IconButton label={copied ? "Copied" : "Copy output"} tooltipSide="right" onClick={copy} disabled={!plainText}>
          {copied ? <Check /> : <Copy />}
        </IconButton>
        <IconButton label="Clear all" tooltipSide="right" onClick={() => runCommand("run.clearOutput")} disabled={!run}>
          <Trash2 />
        </IconButton>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {searchOpen && (
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-2">
            <Search className="size-3.5 text-fg-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              aria-label="Search output"
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
            {query && <span className="text-xs tabular-nums text-fg-subtle">{matchCount} results</span>}
            <IconButton label="Close search" size="sm" onClick={() => (setQuery(""), setSearchOpen(false))}>
              <X />
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ConsoleView query={query} wrap={wrap} follow={follow} />
        </div>
      </div>
    </div>
  );
}
