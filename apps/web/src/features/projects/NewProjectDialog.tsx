"use client";

import { useState } from "react";
import { LANGUAGES, getLanguage } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/primitives";
import { FileIcon } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { useWorkspace } from "./store";

/** New Project dialog: language list on the left, project settings on the right. */
export function NewProjectDialog() {
  const open = useUI((s) => s.newProjectOpen);
  const setDialogOpen = useUI((s) => s.setNewProjectOpen);
  const [language, setLanguage] = useState(LANGUAGES[0]!.id);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const lang = getLanguage(language)!;

  const setOpen = (next: boolean) => {
    if (!next) setName("");
    setDialogOpen(next);
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await useWorkspace.getState().createProject(language, name.trim() || undefined);
    setBusy(false);
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="New Project"
      className="max-w-2xl"
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex min-h-64 overflow-hidden rounded-[6px] border border-line-strong">
        <div role="radiogroup" aria-label="Language" className="w-44 shrink-0 border-r border-line-strong bg-canvas p-1">
          {LANGUAGES.map((l) => (
            <button
              type="button"
              role="radio"
              aria-checked={language === l.id}
              key={l.id}
              onClick={() => setLanguage(l.id)}
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-[4px] px-2 text-left text-sm text-fg",
                language === l.id ? "bg-accent-soft" : "hover:bg-hover",
              )}
            >
              <FileIcon name={l.entryFile} />
              <span className="flex-1">{l.name}</span>
              {l.supportLevel === "beta" && <span className="text-xs text-fg-subtle">Beta</span>}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex-1 space-y-4 bg-surface-2 p-4"
        >
          <label className="grid grid-cols-[88px_1fr] items-center gap-3">
            <span className="text-sm text-fg">Name:</span>
            <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={`${lang.name} project`} aria-label="Project name" />
          </label>
          <div className="grid grid-cols-[88px_1fr] items-center gap-3 text-sm">
            <span className="text-fg">Toolchain:</span>
            <span className="text-fg-muted">{lang.version}</span>
          </div>
          <div className="grid grid-cols-[88px_1fr] items-center gap-3 text-sm">
            <span className="text-fg">Entry file:</span>
            <span className="font-mono text-fg-muted">{lang.entryFile}</span>
          </div>
          <div className="grid grid-cols-[88px_1fr] items-center gap-3 text-sm">
            <span className="text-fg">Debugger:</span>
            <span className="text-fg-muted">{lang.debugger && lang.debugger.supportLevel !== "planned" ? "Available" : "Not available yet"}</span>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
