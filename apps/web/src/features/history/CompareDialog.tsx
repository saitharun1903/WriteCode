"use client";

import { DiffEditor } from "@monaco-editor/react";
import { useMemo, useState } from "react";
import { monacoLanguageForPath } from "@cw/shared";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/primitives";
import { defineThemes } from "@/features/editor/monaco-setup";
import { useWorkspace } from "@/features/projects/store";
import { useResolvedTheme } from "@/features/settings/store";
import { cn } from "@/lib/cn";
import { useSnapshots } from "./snapshot-store";

type Change = "added" | "removed" | "modified" | "same";

/** Side-by-side diff of an older version (history entry or snapshot) against the current project. */
export function CompareDialog() {
  const compare = useSnapshots((s) => s.compare);
  const close = useSnapshots((s) => s.closeCompare);
  const project = useWorkspace((s) => s.project);
  const theme = useResolvedTheme();

  const files = useMemo(() => {
    if (!compare || !project) return [];
    const before = new Map(compare.files.map((f) => [f.path, f.content]));
    const after = new Map(project.files.map((f) => [f.path, f.content]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    return paths.map((path) => {
      const a = before.get(path);
      const b = after.get(path);
      const change: Change = a === undefined ? "added" : b === undefined ? "removed" : a === b ? "same" : "modified";
      return { path, before: a ?? "", after: b ?? "", change };
    });
  }, [compare, project]);

  const firstChanged = files.find((f) => f.change !== "same")?.path ?? files[0]?.path ?? null;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = files.find((f) => f.path === (picked ?? firstChanged));
  const changedCount = files.filter((f) => f.change !== "same").length;

  if (!compare) return null;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          setPicked(null);
          close();
        }
      }}
      title={compare.title}
      description={changedCount === 0 ? "No differences." : `${changedCount} file${changedCount === 1 ? "" : "s"} changed.`}
      className="top-[6vh] h-[84vh] max-w-6xl [&>div:nth-child(2)]:h-[calc(100%-72px)]"
    >
      <div className="flex h-full min-h-0 gap-3">
        <ul className="w-48 shrink-0 overflow-y-auto rounded-md border border-line bg-surface py-1">
          {files.map((f) => (
            <li key={f.path}>
              <button
                onClick={() => setPicked(f.path)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-hover",
                  selected?.path === f.path && "bg-active",
                )}
              >
                <span
                  className={cn(
                    "w-3 text-center font-mono",
                    f.change === "added" && "text-success",
                    f.change === "removed" && "text-danger",
                    f.change === "modified" && "text-warning",
                    f.change === "same" && "text-fg-faint",
                  )}
                >
                  {{ added: "A", removed: "D", modified: "M", same: "·" }[f.change]}
                </span>
                <span className={cn("truncate", f.change === "same" ? "text-fg-subtle" : "text-fg")}>{f.path}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-line">
          {selected && (
            <DiffEditor
              original={selected.before}
              modified={selected.after}
              language={monacoLanguageForPath(selected.path)}
              theme={theme === "light" ? "cw-light" : "cw-dark"}
              beforeMount={defineThemes}
              loading={<Spinner />}
              options={{
                readOnly: true,
                renderSideBySide: true,
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontFamily: "var(--font-code), ui-monospace, monospace",
                fontSize: 12.5,
              }}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}
