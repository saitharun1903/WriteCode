"use client";

import { CircleX, Play, TriangleAlert, X } from "lucide-react";
import dynamic from "next/dynamic";
import { Fragment, useRef } from "react";
import { basename } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/menu";
import { EmptyState, Spinner } from "@/components/ui/primitives";
import { Kbd } from "@/components/ui/kbd";
import { runCommand } from "@/features/commands/registry";
import { useRestriction } from "@/features/interview/restrict";
import { FileIcon } from "@/features/explorer/file-icon";
import { useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";

// Monaco touches `window` on import; load it only in the browser.
const CodeEditor = dynamic(() => import("./CodeEditor").then((m) => m.CodeEditor), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-subtle">
      <Spinner /> Loading editor…
    </div>
  ),
});

export function EditorTabs() {
  const openTabs = useWorkspace((s) => s.openTabs);
  const activeFile = useWorkspace((s) => s.activeFile);
  const entryFile = useWorkspace((s) => s.project?.entryFile);
  const { openFile, closeTab, closeOtherTabs, setEntryFile } = useWorkspace.getState();
  const diagnostics = useExecution((s) => s.diagnostics);
  const listRef = useRef<HTMLDivElement>(null);
  // An interview candidate has no file list to reopen a closed tab from.
  const restricted = useRestriction((r) => r.restricted);

  if (openTabs.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      onWheel={(e) => {
        if (listRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) listRef.current.scrollLeft += e.deltaY;
      }}
      className="flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-line-strong/60 bg-surface-2 [scrollbar-width:none]"
    >
      {openTabs.map((path) => {
        const active = path === activeFile;
        const errors = diagnostics.filter((d) => d.file === path && d.severity === "error").length;
        return (
          <ContextMenu
            key={path}
            entries={[
              { label: "Close", shortcut: "Alt+W", onSelect: () => closeTab(path) },
              { label: "Close Others", disabled: openTabs.length < 2, onSelect: () => closeOtherTabs(path) },
              { kind: "separator" },
              { label: "Set as Entry File", icon: <Play />, disabled: entryFile === path, onSelect: () => setEntryFile(path) },
            ]}
          >
            <div
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={path}
              onClick={() => openFile(path)}
              onAuxClick={(e) => e.button === 1 && closeTab(path)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") return openFile(path);
                if (e.key === "Delete") return closeTab(path);
                // Arrow keys move between tabs, as in any tab strip.
                const i = openTabs.indexOf(path);
                const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: openTabs.length - 1 }[e.key];
                const next = to === undefined ? undefined : openTabs[(to + openTabs.length) % openTabs.length];
                if (!next) return;
                e.preventDefault();
                openFile(next);
                requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[role="tab"][title="${CSS.escape(next)}"]`)?.focus());
              }}
              className={cn(
                "group relative flex min-w-0 max-w-60 shrink-0 items-center gap-1.5 pl-3 pr-1.5 text-sm",
                active ? "text-fg" : "text-fg-muted hover:bg-hover",
              )}
            >
              {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
              <FileIcon name={path} />
              <span className={cn("truncate", errors > 0 && "text-danger underline decoration-wavy decoration-danger/60 underline-offset-2")}>{basename(path)}</span>
              {!restricted && (
                <button
                  aria-label={`Close ${basename(path)}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(path);
                  }}
                  className={cn(
                    "ml-0.5 rounded-[4px] p-0.5 text-fg-subtle hover:bg-active hover:text-fg",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </ContextMenu>
        );
      })}
    </div>
  );
}

/** Top-right problem counter for the open file, like an IDE inspection widget. */
function InspectionWidget() {
  const activeFile = useWorkspace((s) => s.activeFile);
  const diagnostics = useExecution((s) => s.diagnostics);
  const errors = diagnostics.filter((d) => d.file === activeFile && d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.file === activeFile && d.severity === "warning").length;
  if (!errors && !warnings) return null;
  return (
    <button
      onClick={() => runCommand("view.problems")}
      aria-label={`${errors} errors, ${warnings} warnings in this file`}
      className="absolute right-5 top-1.5 z-10 flex h-6 items-center gap-2 rounded-[4px] bg-surface-2/90 px-1.5 text-sm hover:bg-hover"
    >
      {errors > 0 && (
        <span className="flex items-center gap-1 text-fg-muted">
          <CircleX className="size-3.5 text-danger" /> {errors}
        </span>
      )}
      {warnings > 0 && (
        <span className="flex items-center gap-1 text-fg-muted">
          <TriangleAlert className="size-3.5 text-warning" /> {warnings}
        </span>
      )}
    </button>
  );
}

const EMPTY_HINTS: [string, string][] = [
  ["Search Everywhere", "Mod+Shift+P"],
  ["Go to File", "Mod+P"],
  ["Run", "Mod+Enter"],
  ["Debug", "F5"],
  ["Toggle Breakpoint", "F9"],
];

export function EditorArea() {
  const activeFile = useWorkspace((s) => s.activeFile);
  const hasFiles = useWorkspace((s) => (s.project?.files.length ?? 0) > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <EditorTabs />
      {activeFile ? (
        <div className="relative min-h-0 flex-1">
          <InspectionWidget />
          <CodeEditor />
        </div>
      ) : hasFiles ? (
        <div className="flex flex-1 items-center justify-center">
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-2.5 text-sm">
            {EMPTY_HINTS.map(([label, shortcut]) => (
              <Fragment key={label}>
                <dt className="text-right text-fg-subtle">{label}</dt>
                <dd>
                  <Kbd shortcut={shortcut} className="text-sm text-accent" />
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      ) : (
        <EmptyState
          title="This project has no files"
          action={
            <Button size="sm" onClick={() => runCommand("file.newFile")}>
              New file
            </Button>
          }
        />
      )}
    </div>
  );
}
