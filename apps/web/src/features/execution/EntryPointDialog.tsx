"use client";

import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { findEntryPoints, type EntryPoint, type ExecutionMode } from "@cw/shared";
import { Dialog } from "@/components/ui/dialog";
import { FileIcon } from "@/features/explorer/file-icon";
import { useWorkspace } from "@/features/projects/store";
import { showBottom } from "@/features/commands/registry";
import { entryChooser, useExecution } from "./store";

/**
 * Asks which entry point to run when the project's entry file has none and
 * several files do. The choice becomes the project's entry file.
 */
export function EntryPointDialog() {
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const project = useWorkspace((s) => s.project);
  const entries: EntryPoint[] = mode && project ? findEntryPoints(project.language, project.files) : [];

  useEffect(() => {
    entryChooser.open = (m) => setMode(m);
    return () => {
      entryChooser.open = null;
    };
  }, []);

  const choose = (entry: EntryPoint) => {
    const m = mode ?? "run";
    setMode(null);
    showBottom(m === "debug" ? "debug" : "run");
    void useExecution.getState().execute({ mode: m, entry: entry.file });
  };

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => !open && setMode(null)}
      title="Select entry point"
      description={`Several files have a main method. Choose which one to ${mode === "debug" ? "debug" : "run"}; it is remembered for this project.`}
    >
      <ul aria-label="Entry points" className="max-h-72 overflow-y-auto px-2 pb-3">
        {entries.map((e) => (
          <li key={`${e.file}:${e.line}`}>
            <button
              onClick={() => choose(e)}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
            >
              <FileIcon name={e.file} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{e.label}</span>
                <span className="block truncate text-xs text-fg-subtle">
                  {e.file}:{e.line}
                </span>
              </span>
              <Play className="size-3.5 text-success opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
