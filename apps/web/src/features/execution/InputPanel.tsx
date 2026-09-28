"use client";

import { REQUEST_BOUNDS, utf8ByteLength } from "@cw/shared";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";

/** Program stdin, saved with the project and sent with every run. */
export function InputPanel() {
  const stdin = useWorkspace((s) => s.project?.stdin ?? "");
  const setStdin = useWorkspace((s) => s.setStdin);
  const bytes = utf8ByteLength(stdin);
  const over = bytes > REQUEST_BOUNDS.maxStdinBytes;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <textarea
        value={stdin}
        onChange={(e) => setStdin(e.target.value)}
        spellCheck={false}
        aria-label="Program input (stdin)"
        placeholder="Input for your program, one value per line"
        className="min-h-0 flex-1 resize-none bg-surface-2 px-3 py-2 font-mono text-[13px] leading-[20px] text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle"
      />
      {/* The size only matters near the limit. */}
      {bytes > REQUEST_BOUNDS.maxStdinBytes * 0.8 && (
        <div className={cn("flex h-7 shrink-0 items-center justify-end border-t border-line px-3 text-xs text-fg-subtle", over && "text-danger")}>
          {over ? "Input too large · " : ""}
          {(bytes / 1024).toFixed(1)} / {REQUEST_BOUNDS.maxStdinBytes / 1024} KB
        </div>
      )}
    </div>
  );
}
