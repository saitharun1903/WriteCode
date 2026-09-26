"use client";

import { ChevronRight, Loader2 } from "lucide-react";
import { Fragment } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { runCommand } from "@/features/commands/registry";
import { useCursor } from "@/features/editor/bridge";
import { useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { cn } from "@/lib/cn";

function Widget({ children, onClick, label, className }: { children: React.ReactNode; onClick?: () => void; label?: string; className?: string }) {
  const cls = cn("flex h-full items-center gap-1.5 rounded-[4px] px-1.5 text-sm text-fg-subtle", className);
  if (!onClick) return <span className={cls}>{children}</span>;
  return (
    <button onClick={onClick} aria-label={label} className={cn(cls, "hover:bg-hover hover:text-fg")}>
      {children}
    </button>
  );
}

/** Status bar: navigation path on the left, editor and runner state on the right. */
export function StatusBar() {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const saveState = useWorkspace((s) => s.saveState);
  const runner = useExecution((s) => s.runner);
  const runnerReason = useExecution((s) => s.runnerReason);
  const cursor = useCursor();
  const tabSize = useSettings((s) => s.tabSize);

  const runnerLabel = { unknown: "Checking runner…", online: "Runner online", offline: "Runner offline", unavailable: "Runner unavailable" }[runner];
  const crumbs = project ? [project.name, ...(activeFile ? activeFile.split("/") : [])] : [];

  return (
    // data-save-state lets tests (including against production builds) wait for autosave.
    <footer data-save-state={saveState} className="flex h-7 shrink-0 items-center gap-0.5 border-t border-line bg-canvas px-1.5">
      <nav aria-label="Navigation path" className="flex min-w-0 items-center">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />}
            <span className={cn("truncate px-1 text-sm", i === crumbs.length - 1 ? "text-fg-muted" : "text-fg-subtle")}>{c}</span>
          </Fragment>
        ))}
      </nav>

      <div className="ml-auto flex h-full items-center py-0.5">
        {saveState === "saving" || saveState === "pending" ? (
          <Widget>
            <Loader2 className="size-3.5 animate-spin" /> Saving…
          </Widget>
        ) : saveState === "error" ? (
          <Widget className="text-danger">Save failed</Widget>
        ) : null}
        {activeFile && (
          <Widget onClick={() => runCommand("edit.goToLine")} label="Go to line">
            {cursor.line}:{cursor.column}
          </Widget>
        )}
        {project && (
          <>
            <Widget>LF</Widget>
            <Widget>UTF-8</Widget>
            <Widget>{tabSize} spaces</Widget>
          </>
        )}
        <Tooltip content={runnerReason ?? runnerLabel} side="top">
          <button
            onClick={() => void useExecution.getState().checkHealth()}
            aria-label={`${runnerLabel}. Click to recheck.`}
            className="flex h-full items-center gap-1.5 rounded-[4px] px-1.5 text-sm text-fg-subtle hover:bg-hover hover:text-fg"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                runner === "online" && "bg-success",
                (runner === "offline" || runner === "unavailable") && "bg-danger",
                runner === "unknown" && "bg-fg-faint",
              )}
            />
            {runnerLabel}
          </button>
        </Tooltip>
      </div>
    </footer>
  );
}
