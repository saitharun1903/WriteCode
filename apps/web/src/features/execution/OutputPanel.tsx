"use client";

import { Check, Copy, RotateCw, Search, Square, TerminalSquare, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { EmptyState } from "@/components/ui/primitives";
import { runCommand } from "@/features/commands/registry";
import { cn } from "@/lib/cn";
import { STATUS_META, StatusPill, formatBytes, formatDuration } from "./status";
import { isRunning, useExecution, type LogChunk } from "./store";

const streamClass: Record<LogChunk["stream"], string> = {
  stdout: "text-fg",
  stderr: "text-danger",
  compile: "text-warning",
  system: "text-fg-subtle",
};

function highlight(text: string, query: string) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  for (let hit = lower.indexOf(q); hit !== -1; hit = lower.indexOf(q, i)) {
    if (hit > i) out.push(text.slice(i, hit));
    out.push(
      <mark key={hit} className="rounded-[2px] bg-warning/35 text-fg">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    i = hit + q.length;
  }
  out.push(text.slice(i));
  return out;
}

export function OutputPanel() {
  const run = useExecution((s) => s.run);
  const runner = useExecution((s) => s.runner);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const running = isRunning(run);
  const plainText = useMemo(() => run?.log.filter((c) => c.stream !== "system").map((c) => c.text).join("") ?? "", [run?.log]);
  const matchCount = useMemo(() => {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = plainText.toLowerCase();
    let n = 0;
    for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + q.length)) n++;
    return n;
  }, [plainText, query]);

  // Follow new output unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [run?.log]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const result = run?.result;
  const meta = run && !run.error ? STATUS_META[run.status] : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        {run && !run.error && <StatusPill status={run.status} />}
        {result && (
          <dl className="flex items-center gap-3 text-xs text-fg-subtle">
            {result.exitCode !== undefined && (
              <div className="flex gap-1">
                <dt>exit</dt>
                <dd className={cn("font-mono", result.exitCode === 0 ? "text-fg-muted" : "text-danger")}>{result.exitCode}</dd>
              </div>
            )}
            {result.compileTime !== undefined && (
              <div className="flex gap-1">
                <dt>compile</dt>
                <dd className="font-mono text-fg-muted">{formatDuration(result.compileTime)}</dd>
              </div>
            )}
            {result.executionTime !== undefined && (
              <div className="flex gap-1">
                <dt>run</dt>
                <dd className="font-mono text-fg-muted">{formatDuration(result.executionTime)}</dd>
              </div>
            )}
            {result.memoryUsed !== undefined && (
              <div className="hidden gap-1 sm:flex">
                <dt>mem</dt>
                <dd className="font-mono text-fg-muted">{formatBytes(result.memoryUsed)}</dd>
              </div>
            )}
          </dl>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {searchOpen && (
            <div className="mr-1 flex h-6 items-center gap-1 rounded-sm border border-line bg-surface pl-1.5 pr-0.5">
              <Search className="size-3 text-fg-subtle" />
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
                placeholder="Find in output"
                className="w-32 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
              />
              {query && <span className="text-2xs tabular-nums text-fg-subtle">{matchCount}</span>}
              <IconButton label="Close search" size="sm" onClick={() => (setQuery(""), setSearchOpen(false))}>
                <X />
              </IconButton>
            </div>
          )}
          {running && (
            <Button size="sm" variant="ghost" icon={<Square className="size-3 fill-current" />} onClick={() => runCommand("run.cancel")}>
              Stop
            </Button>
          )}
          <IconButton label="Search output" size="sm" onClick={() => setSearchOpen((v) => !v)} active={searchOpen}>
            <Search />
          </IconButton>
          <IconButton label={copied ? "Copied" : "Copy output"} size="sm" onClick={copy} disabled={!plainText}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
          <IconButton label="Clear output" size="sm" onClick={() => runCommand("run.clearOutput")} disabled={!run}>
            <Trash2 />
          </IconButton>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="min-h-0 flex-1 overflow-auto"
        role="log"
        aria-live="polite"
        aria-label="Program output"
      >
        {!run && (
          <EmptyState
            icon={<TerminalSquare />}
            title={runner === "offline" ? "Execution service offline" : "No output yet"}
            description={
              runner === "offline" ? (
                "The API isn't reachable, so programs can't run yet. Start it with pnpm dev (see README)."
              ) : (
                <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
                  Run the entry file with <Kbd shortcut="Mod+Enter" />
                </span>
              )
            }
          />
        )}

        {run?.error && (
          <div role="alert" className="m-3 rounded-md border border-danger/30 bg-danger-soft p-3">
            <p className="text-sm font-medium text-danger">{run.error.title}</p>
            {run.error.detail && <p className="mt-1 text-xs text-fg-muted">{run.error.detail}</p>}
            {run.error.requestId && (
              <p className="mt-2 font-mono text-2xs text-fg-subtle">Request ID: {run.error.requestId}</p>
            )}
            <Button size="sm" className="mt-3" icon={<RotateCw className="size-3" />} onClick={() => runCommand("run.execute")}>
              Retry
            </Button>
          </div>
        )}

        {run && run.log.length > 0 && (
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12.5px] leading-[1.55]">
            {run.log.map((chunk, i) => (
              <span key={i} className={streamClass[chunk.stream]}>
                {chunk.stream === "system" ? chunk.text : highlight(chunk.text, query)}
              </span>
            ))}
            {running && <span className="ml-px inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-fg-subtle" />}
          </pre>
        )}

        {result && meta?.hint && result.status !== "SUCCESS" && (
          <p className="mx-3 mb-3 border-l-2 border-line-strong pl-2 text-xs text-fg-subtle">
            {result.message ?? meta.hint}
          </p>
        )}
        {result && result.status === "SUCCESS" && !plainText && (
          <p className="px-3 pb-3 text-xs text-fg-subtle">Program finished without printing anything.</p>
        )}
      </div>
    </div>
  );
}
