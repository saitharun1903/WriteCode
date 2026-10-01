"use client";

import type { ProjectFile } from "@cw/shared";
import { FileIcon } from "@/features/explorer/file-icon";
import { cn } from "@/lib/cn";

export const linesOf = (content: string) => {
  const text = content.replace(/\n+$/, "");
  return text ? text.split("\n").length : 0;
};

/** The entry file first, then the rest by name: the order files appear in a download or a shared page. */
export const inOrder = (files: readonly ProjectFile[], entryFile: string) =>
  [...files].sort((a, b) => Number(b.path === entryFile) - Number(a.path === entryFile) || a.path.localeCompare(b.path));

/**
 * Which of a project's files to include: every one, only the open one, or a
 * choice of them. `files` are shown in the order given.
 */
export function FilePicker({ id, files, activeFile, chosen, onChange }: { id: string; files: ProjectFile[]; activeFile?: string | null; chosen: Set<string>; onChange: (chosen: Set<string>) => void }) {
  const active = activeFile && files.some((f) => f.path === activeFile) ? activeFile : null;
  const all = files.every((f) => chosen.has(f.path));
  const onlyActive = !!active && chosen.size === 1 && chosen.has(active);
  const toggle = (path: string) => {
    const next = new Set(chosen);
    if (!next.delete(path)) next.add(path);
    onChange(next);
  };
  const quick = "rounded-full border px-3 py-1 text-xs font-medium transition-colors";
  const on = "border-accent bg-accent-soft text-fg";
  const off = "border-line-strong text-fg-muted hover:bg-hover";
  return (
    <section aria-labelledby={id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={id} className="mr-auto text-sm font-semibold text-fg">
          Which code?
        </h3>
        {files.length > 1 && (
          <>
            <button type="button" aria-pressed={all} onClick={() => onChange(new Set(files.map((f) => f.path)))} className={cn(quick, all ? on : off)}>
              All {files.length} files
            </button>
            {active && (
              <button type="button" aria-pressed={onlyActive} onClick={() => onChange(new Set([active]))} className={cn(quick, onlyActive ? on : off)}>
                Only the open file
              </button>
            )}
          </>
        )}
      </div>
      <ul aria-label="Files to include" className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-line-strong/70 bg-surface-2 p-1">
        {files.map((f) => (
          <li key={f.path}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-hover">
              <input type="checkbox" checked={chosen.has(f.path)} onChange={() => toggle(f.path)} className="size-4 accent-[var(--accent)]" />
              <FileIcon name={f.path} />
              <span className="min-w-0 flex-1 truncate text-fg">{f.path}</span>
              <span className="shrink-0 text-xs text-fg-subtle">
                {linesOf(f.content)} line{linesOf(f.content) === 1 ? "" : "s"}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
