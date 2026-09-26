"use client";

import { ChevronDown, CircleX, Info, TriangleAlert } from "lucide-react";
import { basename, type Diagnostic } from "@cw/shared";
import { goToLocation } from "@/features/editor/navigate";
import { FileIcon } from "@/features/explorer/file-icon";
import { useExecution } from "./store";

const icon = {
  error: <CircleX className="size-4 shrink-0 text-danger" />,
  warning: <TriangleAlert className="size-4 shrink-0 text-warning" />,
  info: <Info className="size-4 shrink-0 text-info" />,
};

/** Problems tool window: compiler and runtime diagnostics grouped by file. */
export function ProblemsPanel() {
  const diagnostics = useExecution((s) => s.diagnostics);
  const hasRun = useExecution((s) => !!s.run?.result);

  if (diagnostics.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-2 p-6 text-sm text-fg-subtle">
        {hasRun ? "No problems found in the last run." : "Compiler errors and uncaught exceptions appear here after a run."}
      </div>
    );
  }

  const byFile = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);

  return (
    <div className="h-full overflow-auto bg-surface-2 py-1" aria-label="Problems">
      {[...byFile].map(([file, items]) => (
        <section key={file}>
          <div className="flex h-6 items-center gap-1.5 px-2 text-sm">
            <ChevronDown className="size-3.5 text-fg-subtle" />
            <FileIcon name={file} />
            <span className="text-fg">{basename(file)}</span>
            <span className="text-fg-subtle">
              {items.length} problem{items.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul>
            {items.map((d, i) => (
              <li key={i}>
                <button
                  onClick={() => goToLocation(d.file, d.line, d.column)}
                  className="flex min-h-6 w-full items-start gap-2 py-0.5 pl-9 pr-3 text-left text-sm hover:bg-hover focus-visible:bg-accent-soft"
                >
                  <span className="mt-px">{icon[d.severity]}</span>
                  <span className="min-w-0 flex-1 break-words text-fg">
                    {d.message}{" "}
                    <span className="whitespace-nowrap text-fg-subtle">
                      {d.file}:{d.line}
                      {d.column ? `:${d.column}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
