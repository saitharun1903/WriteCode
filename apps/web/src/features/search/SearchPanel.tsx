"use client";

import { CaseSensitive, ChevronRight, Search } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { IconButton } from "@/components/ui/button";
import { EmptyState, Input, PanelHeader } from "@/components/ui/primitives";
import { goToLocation } from "@/features/editor/navigate";
import { FileIcon } from "@/features/explorer/file-icon";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";

interface Match {
  line: number;
  column: number;
  preview: string;
  start: number;
  length: number;
}

const MAX_RESULTS = 500;

export function SearchPanel() {
  const files = useWorkspace((s) => s.project?.files ?? []);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const deferred = useDeferredValue(query);

  const { results, total, truncated } = useMemo(() => {
    const out: { path: string; matches: Match[] }[] = [];
    let total = 0;
    if (!deferred) return { results: out, total, truncated: false };
    const needle = caseSensitive ? deferred : deferred.toLowerCase();
    for (const file of files) {
      const matches: Match[] = [];
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length && total < MAX_RESULTS; i++) {
        const line = lines[i]!;
        const hay = caseSensitive ? line : line.toLowerCase();
        for (let col = hay.indexOf(needle); col !== -1 && total < MAX_RESULTS; col = hay.indexOf(needle, col + needle.length)) {
          // Trim long lines around the hit so the preview stays readable.
          const from = Math.max(0, col - 24);
          const preview = (from > 0 ? "…" : "") + line.slice(from, col + needle.length + 60).trimEnd();
          matches.push({ line: i + 1, column: col + 1, preview, start: col - from + (from > 0 ? 1 : 0), length: needle.length });
          total++;
        }
      }
      if (matches.length) out.push({ path: file.path, matches });
    }
    return { results: out, total, truncated: total >= MAX_RESULTS };
  }, [files, deferred, caseSensitive]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="Find in Files" />
      <div className="relative mx-3 mb-2 shrink-0">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in project"
          aria-label="Search in project"
          className="pl-7 pr-8"
        />
        <IconButton
          label="Match case"
          size="sm"
          active={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
          className="absolute right-1 top-1/2 -translate-y-1/2"
        >
          <CaseSensitive />
        </IconButton>
      </div>
      {deferred && (
        <p className="shrink-0 px-3 pb-1 text-xs text-fg-subtle">
          {total === 0 ? "No results" : `${total}${truncated ? "+" : ""} result${total === 1 ? "" : "s"} in ${results.length} file${results.length === 1 ? "" : "s"}`}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {!deferred && <EmptyState icon={<Search />} title="Search file contents" description="Matches across every file in the project." />}
        {results.map(({ path, matches }) => {
          const open = !collapsed.has(path);
          return (
            <div key={path}>
              <button
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                className="flex h-6 w-full items-center gap-1.5 px-2 text-sm text-fg hover:bg-hover"
              >
                <ChevronRight className={cn("size-3 text-fg-subtle transition-transform", open && "rotate-90")} />
                <FileIcon name={path} />
                <span className="truncate">{path}</span>
                <span className="ml-auto rounded-sm bg-surface-3 px-1 text-2xs text-fg-subtle">{matches.length}</span>
              </button>
              {open &&
                matches.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => goToLocation(path, m.line, m.column)}
                    className="flex w-full items-baseline gap-2 py-0.5 pl-9 pr-2 text-left hover:bg-hover"
                  >
                    <span className="truncate font-mono text-xs text-fg-muted">
                      {m.preview.slice(0, m.start)}
                      <mark className="rounded-[2px] bg-accent-soft text-fg outline outline-1 outline-accent-line">
                        {m.preview.slice(m.start, m.start + m.length)}
                      </mark>
                      {m.preview.slice(m.start + m.length)}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-2xs text-fg-faint">{m.line}</span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
