"use client";

import { Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { LANGUAGES, PRODUCT, getLanguage, type ProjectSummary } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { DropdownMenu } from "@/components/ui/menu";
import { Input } from "@/components/ui/primitives";
import { FileIcon } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { LogoMark } from "@/features/workspace/Logo";
import { useWorkspace } from "./store";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

const PRIMARY = ["java", "python", "cpp"];

export function StartScreen() {
  const projects = useWorkspace((s) => s.projects);
  const status = useWorkspace((s) => s.status);
  const createProject = useWorkspace((s) => s.createProject);
  const [busy, setBusy] = useState<string | null>(null);

  const create = async (id: string) => {
    setBusy(id);
    await createProject(id);
    setBusy(null);
  };

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-12 sm:px-8 sm:py-20">
        <header className="flex items-center gap-3">
          <LogoMark className="size-7" />
          <div>
            <h1 className="text-base font-semibold tracking-tight text-fg">{PRODUCT.name}</h1>
            <p className="text-sm text-fg-subtle">Write, compile and run real code in the browser.</p>
          </div>
        </header>

        <section aria-labelledby="start-heading">
          <h2 id="start-heading" className="mb-3 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
            Start coding
          </h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRIMARY.map((id) => {
              const lang = getLanguage(id)!;
              return (
                <button
                  key={id}
                  onClick={() => create(id)}
                  disabled={!!busy}
                  className="group flex items-center gap-3 rounded-md border border-line bg-surface-2 px-3 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-3 disabled:opacity-60"
                >
                  <span className="flex size-8 items-center justify-center rounded-md border border-line bg-surface">
                    <FileIcon name={lang.entryFile} className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">New {lang.name} project</span>
                    <span className="block truncate text-xs text-fg-subtle">{lang.version}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className="text-fg-subtle">Also:</span>
            {LANGUAGES.filter((l) => !PRIMARY.includes(l.id)).map((l) => (
              <button key={l.id} onClick={() => create(l.id)} disabled={!!busy} className="text-fg-muted underline-offset-4 hover:text-fg hover:underline">
                {l.name}
                {l.supportLevel === "beta" && <span className="ml-1 text-2xs text-warning">beta</span>}
              </button>
            ))}
            <span className="ml-auto hidden items-center gap-1.5 text-xs text-fg-subtle sm:flex">
              Command palette <Kbd shortcut="Mod+Shift+P" />
            </span>
          </div>
        </section>

        <section aria-labelledby="recent-heading">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="recent-heading" className="text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">
              Recent
            </h2>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => useUI.getState().setNewProjectOpen(true)}>
              New project
            </Button>
          </div>
          {status === "loading" ? (
            <div className="space-y-1" aria-busy>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-md bg-surface-2" />
              ))}
            </div>
          ) : status === "error" ? (
            <p className="rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-danger">
              Local storage is unavailable, so projects can’t be saved. Private browsing or blocked site data can cause this.
            </p>
          ) : projects.length === 0 ? (
            <p className="rounded-md border border-dashed border-line px-4 py-6 text-center text-sm text-fg-subtle">No projects yet</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
              {projects.map((p) => (
                <ProjectRow key={p.id} project={p} />
              ))}
            </ul>
          )}
        </section>

        <p className="text-xs leading-relaxed text-fg-faint">
          Projects are stored in this browser only. Code you run is sent to the execution service, compiled and run in an isolated sandbox, then discarded.
        </p>
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  const { openProject, renameProject, duplicateProject, deleteProject } = useWorkspace.getState();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [confirm, setConfirm] = useState(false);
  const lang = getLanguage(project.language);

  return (
    <li className="group flex items-center gap-3 bg-surface-2 px-3 py-2 hover:bg-surface-3">
      <FileIcon name={lang?.entryFile ?? ""} className="size-4" />
      {renaming ? (
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void renameProject(project.id, name);
            setRenaming(false);
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} aria-label="Project name" />
        </form>
      ) : (
        <button onClick={() => void openProject(project.id)} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-sm text-fg">{project.name}</span>
          <span className="block text-xs text-fg-subtle">
            {lang?.name} · {project.fileCount} file{project.fileCount === 1 ? "" : "s"} · edited {relativeTime(project.updatedAt)}
          </span>
        </button>
      )}
      <DropdownMenu
        align="end"
        trigger={
          <IconButton label={`Actions for ${project.name}`} className="opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100">
            <MoreHorizontal />
          </IconButton>
        }
        entries={[
          { label: "Open", icon: <FolderOpen />, onSelect: () => void openProject(project.id) },
          { label: "Rename", icon: <Pencil />, onSelect: () => (setName(project.name), setRenaming(true)) },
          { label: "Duplicate", icon: <Copy />, onSelect: () => void duplicateProject(project.id) },
          { kind: "separator" },
          { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
        ]}
      />
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${project.name}”?`}
        description="The project, its snapshots and its run history are removed from this browser. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" autoFocus onClick={() => void deleteProject(project.id).then(() => setConfirm(false))}>
              Delete project
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </li>
  );
}
