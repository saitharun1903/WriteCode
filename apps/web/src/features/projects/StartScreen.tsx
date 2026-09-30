"use client";

import { ArrowRight, Check, ClipboardList, Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { LANGUAGES, PRODUCT, getLanguage, type ProjectSummary } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/menu";
import { Input, Spinner } from "@/components/ui/primitives";
import { ProjectBadge } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { LANDING_PAGES } from "@/features/seo/pages";
import { useInterviewUI } from "@/features/interview/ui";
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
    <div className="relative h-full overflow-y-auto bg-surface-2">
      {/* A soft wash of the brand colour behind the heading. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(60%_100%_at_30%_0%,rgb(53_116_240/0.13),transparent)]" />
      <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-10 sm:px-8 sm:pt-14">
        <header className="mb-10 max-w-2xl">
          <h1 className="text-[34px] font-bold leading-tight tracking-tight text-fg sm:text-[40px]">{PRODUCT.name}</h1>
          <p className="mt-2 text-base leading-relaxed text-fg-muted sm:text-[17px]">
            Write, run, debug and visualize code right in your browser. Java, Python, C, C++, JavaScript and TypeScript, free and without signing up.
          </p>
        </header>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-8">
          <div className="min-w-0">
            <section aria-labelledby="new-heading">
              <div className="flex items-center justify-between gap-4">
                <h2 id="new-heading" className="text-lg font-semibold tracking-tight text-fg">
                  New project
                </h2>
                <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => useUI.getState().setNewProjectOpen(true)}>
                  Custom…
                </Button>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.id}
                    aria-label={`New ${lang.name} project`}
                    disabled={!!busy}
                    onClick={() => create(lang.id)}
                    className={cn(
                      "group relative flex items-center gap-3.5 overflow-hidden rounded-2xl border border-line-strong/70 bg-surface p-4 text-left shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-all duration-150",
                      "hover:-translate-y-0.5 hover:border-accent/70 hover:shadow-[0_10px_28px_-14px_rgb(53_116_240/0.55)] disabled:opacity-60",
                    )}
                  >
                    <LanguageMark id={lang.id} size={44} className="rounded-xl" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-fg">{lang.name}</span>
                      <span className="block text-[13px] leading-snug text-fg-subtle">{lang.version}</span>
                    </span>
                    {busy === lang.id ? (
                      <Spinner className="size-4" />
                    ) : (
                      <ArrowRight className="size-4 shrink-0 text-fg-faint transition-all group-hover:translate-x-0.5 group-hover:text-accent" />
                    )}
                  </button>
                ))}
              </div>
            </section>

            {status === "error" && (
              <p className="mt-10 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-fg">
                Browser storage is unavailable, so projects can’t be saved. Private browsing or blocked site data can cause this.
              </p>
            )}

            {projects.length > 0 ? (
              <section aria-labelledby="recent-heading" className="mt-12">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="recent-heading" className="text-lg font-semibold tracking-tight text-fg">
                    Recent projects <span className="ml-1 text-sm font-normal text-fg-subtle">{projects.length}</span>
                  </h2>
                  {projects.length > 3 && (
                    <div className="relative w-full sm:w-60">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="h-8 rounded-lg pl-8" />
                    </div>
                  )}
                </div>
                <ul aria-label="Recent projects" className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {filtered.map((p) => (
                    <ProjectCard key={p.id} project={p} />
                  ))}
                </ul>
                {filtered.length === 0 && <p className="py-8 text-center text-sm text-fg-subtle">No projects match “{query}”.</p>}
              </section>
            ) : (
              <p className="mt-10 flex items-center gap-2 text-sm text-fg-subtle">
                <FolderOpen className="size-4" />
                Your projects are saved in this browser and show up here.
              </p>
            )}
          </div>

          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <InterviewCard />
            <nav aria-label="Compilers and tools" className="rounded-2xl border border-line-strong/70 bg-surface p-5">
              <h2 className="text-[13px] font-semibold text-fg">Compilers and tools</h2>
              <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[13px] lg:grid-cols-1">
                {LANDING_PAGES.map((p) => (
                  <li key={p.slug}>
                    <a href={`/${p.slug}`} className="text-fg-subtle transition-colors hover:text-accent">
                      {p.kind === "language" ? `Online ${p.label}` : p.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>
        </div>
      </div>
    </div>
  );
}

const INTERVIEW_POINTS = [
  "Type a topic and get the problem, sample tests and tricky hidden tests",
  "Watch the candidate's code, runs, pastes and tab switches live",
  "Hidden tests show correctness and how the code scales",
  "Replay the coding and download a report",
];

/** Interviews live beside the everyday tools, not among them. */
function InterviewCard() {
  return (
    <section aria-labelledby="interview-heading" className="overflow-hidden rounded-2xl border border-line-strong/70 bg-surface">
      <div className="border-b border-line-strong/50 bg-[linear-gradient(135deg,rgb(53_116_240/0.14),transparent_70%)] p-5 pb-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-white shadow-[0_6px_16px_-6px_rgb(53_116_240/0.8)]">
          <ClipboardList className="size-5" />
        </span>
        <h2 id="interview-heading" className="mt-3 text-base font-semibold text-fg">
          Coding interviews
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">Interview a candidate in the same editor, with only the compiler and Run on their side.</p>
      </div>
      <div className="p-5 pt-4">
        <ul className="space-y-2.5">
          {INTERVIEW_POINTS.map((t) => (
            <li key={t} className="flex gap-2 text-[13px] leading-snug text-fg-muted">
              <Check className="mt-0.5 size-3.5 shrink-0 text-accent" />
              {t}
            </li>
          ))}
        </ul>
        <Button variant="primary" className="mt-5 h-9 w-full rounded-lg text-[13px]" onClick={() => useInterviewUI.getState().openSetup("create")}>
          Start a coding interview
        </Button>
      </div>
    </section>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { openProject, renameProject, duplicateProject, deleteProject } = useWorkspace.getState();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [confirm, setConfirm] = useState(false);
  const lang = getLanguage(project.language);

  return (
    <li className="group relative rounded-2xl border border-line-strong/70 bg-surface transition-colors hover:border-fg-faint">
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
