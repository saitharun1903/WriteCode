"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { ArrowRightLeft, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { FileIcon } from "@/features/explorer/file-icon";
import { planImport, readDropped, readPicked, type ImportPlan, type IncomingFile } from "./import";
import { useWorkspace } from "./store";

/** The import waiting for the user's review. */
const useImport = create<{ plan: ImportPlan | null; set: (plan: ImportPlan | null) => void }>((set) => ({ plan: null, set: (plan) => set({ plan }) }));

/** Opens the system file picker; set by the mounted dialog. */
export const importPicker: { files: (() => void) | null; folder: (() => void) | null } = { files: null, folder: null };

/** Reviews files from the picker or a drop before adding them to the project. */
export async function reviewImport(incoming: IncomingFile[] | Promise<IncomingFile[]>) {
  const project = useWorkspace.getState().project;
  if (!project) return;
  const files = await incoming;
  if (!files.length) return;
  useImport.getState().set(planImport(project, files));
}

export function importFromDrop(data: DataTransfer) {
  void reviewImport(readDropped(data));
}

export function ImportDialog() {
  const plan = useImport((s) => s.plan);
  const setPlan = useImport((s) => s.set);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    importPicker.files = () => filesInput.current?.click();
    importPicker.folder = () => folderInput.current?.click();
    return () => {
      importPicker.files = null;
      importPicker.folder = null;
    };
  }, []);

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (list?.length) void reviewImport(readPicked(list));
    e.target.value = "";
  };

  const confirm = () => {
    if (!plan?.files.length) return setPlan(null);
    useWorkspace.getState().importFiles(plan.files);
    const replaced = plan.files.filter((f) => f.replaces).length;
    toast.success(
      `Imported ${plan.files.length} ${plan.files.length === 1 ? "file" : "files"}`,
      replaced ? `${replaced} existing ${replaced === 1 ? "file was" : "files were"} replaced.` : undefined,
    );
    setPlan(null);
  };

  const count = plan?.files.length ?? 0;
  const replacing = plan?.files.filter((f) => f.replaces).length ?? 0;

  return (
    <>
      <input ref={filesInput} type="file" multiple hidden onChange={onPicked} aria-label="Choose files to import" />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        onChange={onPicked}
        aria-label="Choose a folder to import"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
      <Dialog
        open={!!plan}
        onOpenChange={(open) => !open && setPlan(null)}
        title={count ? `Import ${count} ${count === 1 ? "file" : "files"}` : "Nothing to import"}
        description={count ? (replacing ? `${replacing} will replace a file with the same name.` : "They are added to this project.") : "None of the chosen files can be added."}
        className="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPlan(null)}>
              Cancel
            </Button>
            {count > 0 && (
              <Button variant="primary" onClick={confirm} autoFocus>
                Import
              </Button>
            )}
          </>
        }
      >
        {plan && (
          <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-line-strong/70">
            <ul aria-label="Files to import">
              {plan.files.map((f) => (
                <li key={f.path} className="flex h-8 items-center gap-2 border-b border-line-strong/40 px-3 text-sm last:border-b-0">
                  <FileIcon name={f.path} />
                  <span className="min-w-0 flex-1 truncate text-fg" title={f.renamedFrom ? `Renamed from ${f.renamedFrom}` : undefined}>
                    {f.path}
                  </span>
                  {f.replaces && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-warning">
                      <ArrowRightLeft className="size-3" /> replaces
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {plan.skipped.length > 0 && (
              <ul aria-label="Skipped files" className="border-t border-line-strong/70 bg-surface-2/60">
                {plan.skipped.map((s) => (
                  <li key={s.path} className="flex h-8 items-center gap-2 px-3 text-sm text-fg-subtle">
                    <FileWarning className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{s.path}</span>
                    <span className="shrink-0 text-xs">{s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
