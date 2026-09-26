"use client";

import { useState } from "react";
import { LANGUAGES } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/primitives";
import { FileIcon } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { useWorkspace } from "./store";

export function NewProjectDialog() {
  const open = useUI((s) => s.newProjectOpen);
  const setDialogOpen = useUI((s) => s.setNewProjectOpen);
  const [language, setLanguage] = useState("java");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const setOpen = (next: boolean) => {
    if (!next) setName("");
    setDialogOpen(next);
  };

  const submit = async () => {
    setBusy(true);
    await useWorkspace.getState().createProject(language, name.trim() || undefined);
    setBusy(false);
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="New project"
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            Create project
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="mb-1.5 block text-xs text-fg-muted">Name</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`${LANGUAGES.find((l) => l.id === language)?.name} project`} />
        </label>
        <fieldset>
          <legend className="mb-1.5 text-xs text-fg-muted">Language</legend>
          <div role="radiogroup" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {LANGUAGES.map((l) => (
              <button
                type="button"
                role="radio"
                aria-checked={language === l.id}
                key={l.id}
                onClick={() => setLanguage(l.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm",
                  language === l.id ? "border-accent-line bg-accent-soft text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
                )}
              >
                <FileIcon name={l.entryFile} />
                <span className="flex-1">{l.name}</span>
                {l.supportLevel === "beta" && <span className="text-2xs text-warning">beta</span>}
              </button>
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
