"use client";

import { ChevronRight, FileCode2, Play, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useRef } from "react";
import { basename } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { ContextMenu } from "@/components/ui/menu";
import { EmptyState, Spinner } from "@/components/ui/primitives";
import { Kbd } from "@/components/ui/kbd";
import { runCommand } from "@/features/commands/registry";
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

  if (openTabs.length === 0) return <div className="h-9 shrink-0 border-b border-line bg-surface" />;

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      onWheel={(e) => {
        if (listRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) listRef.current.scrollLeft += e.deltaY;
      }}
      className="flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-line bg-surface [scrollbar-width:none]"
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
                if (e.key === "Enter" || e.key === " ") openFile(path);
              }}
              className={cn(
                "group relative flex min-w-0 max-w-56 shrink-0 items-center gap-2 border-r border-line pl-3 pr-1.5 text-sm",
                active ? "bg-surface-2 text-fg" : "text-fg-subtle hover:bg-hover hover:text-fg-muted",
              )}
            >
              {active && <span className="absolute inset-x-0 top-0 h-px bg-accent" />}
              <FileIcon name={path} />
              <span className={cn("truncate", errors > 0 && "text-danger")}>{basename(path)}</span>
              {errors > 0 && <span className="rounded-sm bg-danger-soft px-1 text-2xs text-danger">{errors}</span>}
              <button
                aria-label={`Close ${basename(path)}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(path);
                }}
                className={cn(
                  "rounded-sm p-0.5 text-fg-subtle hover:bg-active hover:text-fg",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          </ContextMenu>
        );
      })}
    </div>
  );
}

function Breadcrumbs() {
  const activeFile = useWorkspace((s) => s.activeFile);
  const projectName = useWorkspace((s) => s.project?.name);
  if (!activeFile) return null;
  const parts = activeFile.split("/");
  return (
    <nav aria-label="Breadcrumb" className="flex h-6 shrink-0 items-center gap-1 bg-surface-2 px-3 text-xs text-fg-subtle">
      <span>{projectName}</span>
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          <ChevronRight className="size-3 text-fg-faint" />
          <span className={cn(i === parts.length - 1 && "text-fg-muted")}>{p}</span>
        </span>
      ))}
    </nav>
  );
}

export function EditorArea() {
  const activeFile = useWorkspace((s) => s.activeFile);
  const hasFiles = useWorkspace((s) => (s.project?.files.length ?? 0) > 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      <EditorTabs />
      {activeFile ? (
        <>
          <Breadcrumbs />
          <div className="min-h-0 flex-1">
            <CodeEditor />
          </div>
        </>
      ) : (
        <EmptyState
          icon={<FileCode2 />}
          title={hasFiles ? "No file open" : "This project has no files"}
          description={
            <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
              Open a file with <Kbd shortcut="Mod+P" /> or from the explorer.
            </span>
          }
          action={
            !hasFiles && (
              <Button size="sm" onClick={() => runCommand("file.newFile")}>
                New file
              </Button>
            )
          }
        />
      )}
    </div>
  );
}
