"use client";

import { AlertTriangle, CircleCheck, Info, XCircle } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";
import { goToLocation } from "@/features/editor/navigate";
import { cn } from "@/lib/cn";
import { useExecution } from "./store";

const icon = {
  error: <XCircle className="size-3.5 text-danger" />,
  warning: <AlertTriangle className="size-3.5 text-warning" />,
  info: <Info className="size-3.5 text-info" />,
};

export function ProblemsPanel() {
  const diagnostics = useExecution((s) => s.diagnostics);
  const hasRun = useExecution((s) => !!s.run?.result);

  if (diagnostics.length === 0) {
    return (
      <EmptyState
        icon={<CircleCheck />}
        title={hasRun ? "No problems detected in the last run" : "No problems"}
        description="Compiler errors and uncaught exceptions from runs appear here, linked to their source line."
      />
    );
  }

  return (
    <ul className="h-full overflow-auto py-1" aria-label="Problems">
      {diagnostics.map((d, i) => (
        <li key={i}>
          <button
            onClick={() => goToLocation(d.file, d.line, d.column)}
            className={cn("flex w-full items-start gap-2 px-3 py-1 text-left text-sm hover:bg-hover focus-visible:bg-hover")}
          >
            <span className="mt-0.5">{icon[d.severity]}</span>
            <span className="min-w-0 flex-1">
              <span className="break-words text-fg">{d.message}</span>
              <span className="ml-2 font-mono text-xs text-fg-subtle">
                {d.file}:{d.line}
                {d.column ? `:${d.column}` : ""}
              </span>
            </span>
            <span className="shrink-0 text-2xs uppercase tracking-wider text-fg-faint">{d.source}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
