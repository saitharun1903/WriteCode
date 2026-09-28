"use client";

import { useMemo } from "react";
import { Eraser } from "lucide-react";
import { REQUEST_BOUNDS, utf8ByteLength } from "@cw/shared";
import { useWorkspace } from "@/features/projects/store";
import { describeReads } from "@/features/tests/read-input";
import { entryOf } from "@/features/tests/store";
import { cn } from "@/lib/cn";

/** Program stdin, saved with the project and sent with every run. */
export function InputPanel() {
  const stdin = useWorkspace((s) => s.project?.stdin ?? "");
  const setStdin = useWorkspace((s) => s.setStdin);
  const project = useWorkspace((s) => s.project);
  const bytes = utf8ByteLength(stdin);
  const over = bytes > REQUEST_BOUNDS.maxStdinBytes;
  const entry = project ? entryOf(project) : "";
  const source = project?.files.find((f) => f.path === entry)?.content ?? "";
  const language = project?.language ?? "";
  // What the program reads, from its current code, so the input can be checked against it.
  const reads = useMemo(() => describeReads(language, source), [language, source]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-fg-subtle">{stdin ? "Given to the program when you press Run." : "Empty: you type the input while the program runs."}</span>
        {reads.length > 0 && (
          <span className="rounded-md bg-hover px-2 py-0.5 text-fg-muted">
            Reads <span className="text-fg">{reads.join(", then ")}</span>
          </span>
        )}
        {stdin && (
          <button
            type="button"
            onClick={() => setStdin("")}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <Eraser className="size-3.5" /> Clear
          </button>
        )}
      </div>
      <textarea
        value={stdin}
        onChange={(e) => setStdin(e.target.value)}
        spellCheck={false}
        aria-label="Program input (stdin)"
        placeholder="Input for your program, one value per line"
        className={cn(
          "min-h-0 flex-1 resize-none rounded-lg border border-line-strong/70 bg-surface-2 px-3 py-2.5 font-mono text-[13.5px] leading-[22px] text-fg outline-none transition-colors placeholder:font-sans placeholder:text-fg-faint focus:border-accent",
          over && "border-danger",
        )}
      />
      {/* The size only matters near the limit. */}
      {bytes > REQUEST_BOUNDS.maxStdinBytes * 0.8 && (
        <p className={cn("text-right text-xs text-fg-subtle", over && "text-danger")}>
          {over ? "Input too large · " : ""}
          {(bytes / 1024).toFixed(1)} / {REQUEST_BOUNDS.maxStdinBytes / 1024} KB
        </p>
      )}
    </div>
  );
}
