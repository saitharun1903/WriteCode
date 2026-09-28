"use client";

import { ArrowDownUp, ArrowRight, Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Repeat2, Search, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import { LANGUAGES, getLanguage, type ProjectSummary } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/menu";
import { Input } from "@/components/ui/primitives";
import { ProjectBadge } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { EXAMPLES } from "./examples";
import { useWorkspace } from "./store";

function relativeTime(verb: string, ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60_000);
  if (min < 1) return `${verb} just now`;
  if (min < 60) return `${verb} ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${verb} ${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${verb} ${d} d ago`;
  return `${verb} ${new Date(ts).toLocaleDateString()}`;
}

/** "Ran 5 min ago" or "Edited 2 h ago", whichever happened last. */
function activityLabel(p: ProjectSummary): string {
  return p.lastRunAt && p.lastRunAt >= p.updatedAt ? relativeTime("Ran", p.lastRunAt) : relativeTime("Edited", p.updatedAt);
}

/** Brand-coloured tile with a language monogram. */
const MARKS: Record<string, { text: string; bg: string; fg: string }> = {
  java: { text: "J", bg: "#e76f00", fg: "#fff" },
  python: { text: "Py", bg: "#3776ab", fg: "#ffd43b" },
  cpp: { text: "C++", bg: "#00599c", fg: "#fff" },
  c: { text: "C", bg: "#5c6bc0", fg: "#fff" },
  javascript: { text: "JS", bg: "#f0db4f", fg: "#1e1f22" },
  typescript: { text: "TS", bg: "#3178c6", fg: "#fff" },
};

export function LanguageMark({ id, size = 40, className }: { id: string; size?: number; className?: string }) {
  const m = MARKS[id] ?? { text: "?", bg: "#6c707e", fg: "#fff" };
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[10px] font-bold tracking-tight", className)}
      style={{ width: size, height: size, background: m.bg, color: m.fg, fontSize: size * (m.text.length > 2 ? 0.3 : 0.38) }}
    >
      {m.text}
    </span>
  );
}

const EXAMPLE_ICONS: Record<string, React.ReactNode> = {
  "binary-search": <Search />,
  "bubble-sort": <ArrowDownUp />,
  "reverse-linked-list": <Undo2 />,
  fibonacci: <Repeat2 />,
};

/** Classic programs with their input and tests ready: open one and press Run, Visualize or Run all. */
function Examples({ busy }: { busy: boolean }) {
  const createExample = useWorkspace((s) => s.createExample);
  const [opening, setOpening] = useState<string | null>(null);
  const open = async (id: string, language: string) => {
    setOpening(`${id}:${language}`);
    await createExample(id, language);
    setOpening(null);
  };
  return (
    <section aria-labelledby="examples-heading" className="mt-12">
      <h2 id="examples-heading" className="text-lg font-semibold tracking-tight text-fg">
        Examples
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {EXAMPLES.map((ex) => (
          <li key={ex.id} className="flex flex-col rounded-xl border border-line-strong bg-surface p-4">
            <span className="flex size-9 items-center justify-center rounded-[10px] bg-accent-soft/60 text-accent [&_svg]:size-[18px]">{EXAMPLE_ICONS[ex.id]}</span>
            <h3 className="mt-3 text-[15px] font-semibold text-fg">{ex.title}</h3>
            <p className="mt-0.5 flex-1 text-sm text-fg-subtle">{ex.about}</p>
            <div className="mt-3 flex gap-2">
              {ex.versions.map((v) => {
                const lang = getLanguage(v.language)!;
                return (
                  <button
                    key={v.language}
                    type="button"
                    disabled={busy || !!opening}
                    aria-label={`Open ${ex.title} in ${lang.name}`}
                    onClick={() => void open(ex.id, v.language)}
                    className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line-strong text-[13px] text-fg-muted transition-colors hover:border-accent hover:text-fg disabled:opacity-60"
                  >
                    <LanguageMark id={v.language} size={18} className="rounded-[5px]" />
                    {lang.name}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Welcome screen shown when no project is open. */
export function StartScreen() {
  const allProjects = useWorkspace((s) => s.projects);
  // Projects that were only opened (never run or changed) are not recent work.
  const projects = allProjects.filter((p) => !p.untouched);
  const status = useWorkspace((s) => s.status);
  const createProject = useWorkspace((s) => s.createProject);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const filtered = projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  const create = async (id: string) => {
    setBusy(id);
    await createProject(id);
    setBusy(null);
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        <section aria-labelledby="new-heading">
          <div className="flex items-end justify-between gap-4">
            <h1 id="new-heading" className="text-2xl font-semibold tracking-tight text-fg">
              New project
            </h1>
            <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => useUI.getState().setNewProjectOpen(true)}>
              Custom…
            </Button>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.id}
                aria-label={`New ${lang.name} project`}
                disabled={!!busy}
                onClick={() => create(lang.id)}
                className={cn(
                  "group flex items-center gap-4 rounded-xl border border-line-strong bg-surface p-4 text-left transition-all duration-150",
                  "hover:-translate-y-0.5 hover:border-accent hover:shadow-[0_6px_20px_-10px_rgb(53_116_240/0.5)] disabled:opacity-60",
                )}
              >
                <LanguageMark id={lang.id} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold text-fg">{lang.name}</span>
                  <span className="block truncate text-sm text-fg-subtle">{lang.version}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-fg-faint transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
              </button>
            ))}
          </div>
        </section>

        {status === "error" && (
          <p className="mt-10 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-fg">
            Browser storage is unavailable, so projects can’t be saved. Private browsing or blocked site data can cause this.
          </p>
        )}

        {projects.length > 0 && (
          <section aria-labelledby="recent-heading" className="mt-12">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="recent-heading" className="text-lg font-semibold tracking-tight text-fg">
                Recent projects <span className="ml-1 text-sm font-normal text-fg-subtle">{projects.length}</span>
              </h2>
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="h-8 pl-8" />
              </div>
            </div>
            <ul aria-label="Recent projects" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </ul>
            {filtered.length === 0 && <p className="py-8 text-center text-sm text-fg-subtle">No projects match “{query}”.</p>}
          </section>
        )}

        <Examples busy={!!busy} />
      </div>
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { openProject, renameProject, duplicateProject, deleteProject } = useWorkspace.getState();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [confirm, setConfirm] = useState(false);
  const lang = getLanguage(project.language);

  return (
    <li className="group relative rounded-xl border border-line-strong bg-surface transition-colors hover:border-fg-faint">
      {renaming ? (
        <form
          className="p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void renameProject(project.id, name);
            setRenaming(false);
          }}
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setRenaming(false)} aria-label="Project name" />
        </form>
      ) : (
        <button onClick={() => void openProject(project.id)} className="flex w-full items-start gap-3 p-4 pr-12 text-left">
          <ProjectBadge name={project.name} className="size-10 rounded-[10px] text-sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold text-fg">{project.name}</span>
            <span className="mt-0.5 flex items-center gap-1.5 text-sm text-fg-subtle">
              <LanguageMark id={project.language} size={14} className="rounded-[3px]" />
              {lang?.name} · {project.fileCount} file{project.fileCount === 1 ? "" : "s"}
            </span>
            <span className="mt-2 block text-xs text-fg-subtle">{activityLabel(project)}</span>
          </span>
        </button>
      )}
      <div className="absolute right-2 top-2">
        <DropdownMenu
          align="end"
          trigger={
            <IconButton label={`Actions for ${project.name}`} className="opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal />
            </IconButton>
          }
          entries={[
            { label: "Open", icon: <FolderOpen />, onSelect: () => void openProject(project.id) },
            { label: "Rename…", icon: <Pencil />, onSelect: () => (setName(project.name), setRenaming(true)) },
            { label: "Duplicate", icon: <Copy />, onSelect: () => void duplicateProject(project.id) },
            { kind: "separator" },
            { label: "Delete…", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
          ]}
        />
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${project.name}”?`}
        description="The project, its snapshots and its run history are removed from this browser. This cannot be undone."
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" autoFocus onClick={() => void deleteProject(project.id).then(() => setConfirm(false))}>
              Delete
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </li>
  );
}
