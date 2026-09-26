"use client";

import { AlertTriangle, Check, CircleDot, Loader2, XCircle } from "lucide-react";
import { getLanguage } from "@cw/shared";
import { Tooltip } from "@/components/ui/tooltip";
import { useCursor } from "@/features/editor/bridge";
import { useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { runCommand } from "@/features/commands/registry";
import { cn } from "@/lib/cn";

function Item({ children, onClick, label }: { children: React.ReactNode; onClick?: () => void; label?: string }) {
  const cls = "flex h-full items-center gap-1.5 px-2 text-2xs text-fg-subtle";
  if (!onClick) return <span className={cls}>{children}</span>;
  return (
    <button onClick={onClick} aria-label={label} className={cn(cls, "hover:bg-hover hover:text-fg")}>
      {children}
    </button>
  );
}

export function StatusBar() {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const saveState = useWorkspace((s) => s.saveState);
  const runner = useExecution((s) => s.runner);
  const runnerReason = useExecution((s) => s.runnerReason);
  const diagnostics = useExecution((s) => s.diagnostics);
  const cursor = useCursor();
  const tabSize = useSettings((s) => s.tabSize);
  const lang = project ? getLanguage(project.language) : undefined;
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  const runnerLabel = { unknown: "Checking runner…", online: "Runner online", offline: "Runner offline", unavailable: "Runner unavailable" }[runner];

  return (
    <footer className="flex h-6 shrink-0 items-stretch border-t border-line bg-canvas">
      <Tooltip content={runnerReason ?? runnerLabel} side="top">
        <button
          onClick={() => void useExecution.getState().checkHealth()}
          aria-label={`${runnerLabel}. Click to recheck.`}
          className="flex items-center gap-1.5 px-2 text-2xs text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <CircleDot
            className={cn(
              "size-2.5",
              runner === "online" && "text-success",
              (runner === "offline" || runner === "unavailable") && "text-danger",
              runner === "unknown" && "text-fg-faint",
            )}
          />
          {runnerLabel}
        </button>
      </Tooltip>
      {project && (
        <Item onClick={() => runCommand("view.problems")} label={`${errors} errors, ${warnings} warnings`}>
          <XCircle className="size-3" /> {errors}
          <AlertTriangle className="ml-1 size-3" /> {warnings}
        </Item>
      )}
      {project && (
        <Item>
          {saveState === "saving" || saveState === "pending" ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Saving
            </>
          ) : saveState === "error" ? (
            <span className="text-danger">Save failed</span>
          ) : (
            <>
              <Check className="size-3" /> Saved locally
            </>
          )}
        </Item>
      )}
      <div className="ml-auto flex items-stretch">
        {activeFile && (
          <Item onClick={() => runCommand("edit.goToLine")} label="Go to line">
            Ln {cursor.line}, Col {cursor.column}
          </Item>
        )}
        {project && <Item>Spaces: {tabSize}</Item>}
        {lang && (
          <Item>
            {lang.name} {lang.version}
            {lang.supportLevel === "beta" && <span className="rounded-sm bg-warning-soft px-1 text-warning">beta</span>}
          </Item>
        )}
      </div>
    </footer>
  );
}
