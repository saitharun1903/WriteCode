"use client";

import { ArrowRight, ClipboardList, Copy, FolderOpen, MoreHorizontal, Pencil, Plus, Search, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { LANGUAGES, PRODUCT, getLanguage, type ProjectSummary } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/menu";
import { Input } from "@/components/ui/primitives";
import { ProjectBadge } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { HOME_FAQS, HOME_FEATURES, LANDING_PAGES } from "@/features/seo/pages";
import { useInterviewUI } from "@/features/interview/ui";
import { TransferButton } from "@/features/export/ExportUI";
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
  // Projects that were only opened (never run or changed) are not recent work. Interviews have a list of their own.
  const projects = allProjects.filter((p) => !p.untouched && !p.interview);
  const interviews = allProjects.filter((p) => p.interview).sort((a, b) => (b.interview!.startedAt ?? b.updatedAt) - (a.interview!.startedAt ?? a.updatedAt));
  const status = useWorkspace((s) => s.status);
  const createProject = useWorkspace((s) => s.createProject);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** The language chosen for a new project, while its name is being asked. */
  const [naming, setNaming] = useState<string | null>(null);
  const filtered = projects.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  const create = async (id: string, name: string) => {
    setBusy(id);
    await createProject(id, name);
    setBusy(null);
    setNaming(null);
  };

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-9">
          <h1 className="text-[28px] font-bold tracking-tight text-fg max-lg:leading-tight">{PRODUCT.name}</h1>
          <p className="mt-1.5 text-[15px] text-fg-muted max-lg:mt-2.5 max-lg:leading-snug">
            Free online compiler, debugger and visualizer for {LANGUAGES.slice(0, -1).map((l) => l.name).join(", ")} and {LANGUAGES[LANGUAGES.length - 1]!.name}.
          </p>
        </header>
        <section aria-labelledby="new-heading">
          <div className="flex items-end justify-between gap-4">
            <h2 id="new-heading" className="text-xl font-semibold tracking-tight text-fg">
              New project
            </h2>
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
                onClick={() => setNaming(lang.id)}
                className={cn(
                  "group flex items-center gap-4 rounded-xl border border-line-strong bg-surface p-4 text-left transition-all duration-150",
                  "hover:-translate-y-0.5 hover:border-accent disabled:opacity-60",
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

        <NameDialog key={naming ?? "none"} language={naming} taken={allProjects.map((p) => p.name)} busy={!!busy} onCancel={() => setNaming(null)} onCreate={(name) => void create(naming!, name)} />

        {status === "error" && (
          <p className="mt-10 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-fg">
            Browser storage is unavailable, so projects can’t be saved. Private browsing or blocked site data can cause this.
          </p>
        )}

        {interviews.length > 0 && (
          <section aria-labelledby="interviews-heading" className="mt-12">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="interviews-heading" className="text-lg font-semibold tracking-tight text-fg">
                Interviews <span className="ml-1 text-sm font-normal text-fg-subtle">{interviews.length}</span>
              </h2>
              <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => useInterviewUI.getState().openSetup("create")}>
                New interview
              </Button>
            </div>
            <ul aria-label="Interviews" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {interviews.map((p) => (
                <InterviewCard key={p.id} project={p} />
              ))}
            </ul>
          </section>
        )}

        {projects.length > 0 && (
          <section aria-labelledby="recent-heading" className="mt-12">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="recent-heading" className="text-lg font-semibold tracking-tight text-fg">
                Recent projects <span className="ml-1 text-sm font-normal text-fg-subtle">{projects.length}</span>
              </h2>
              <TransferButton className="sm:ml-auto" />
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

        <section aria-labelledby="about-heading" className="mt-14 border-t border-line-strong/60 pt-8">
          <h2 id="about-heading" className="text-lg font-semibold tracking-tight text-fg">
            What you can do in {PRODUCT.name}
          </h2>
          <ul className="mt-4 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {HOME_FEATURES.map((f) => (
              <li key={f.slug}>
                <h3 className="text-sm font-semibold text-fg">
                  <a href={`/${f.slug}`} className="hover:text-accent hover:underline">
                    {f.title}
                  </a>
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">{f.text}</p>
              </li>
            ))}
          </ul>
          <h2 className="mt-10 text-lg font-semibold tracking-tight text-fg">Questions and answers</h2>
          <div className="mt-3 divide-y divide-line-strong/60 rounded-xl border border-line-strong/60 bg-surface">
            {HOME_FAQS.map((f) => (
              <details key={f.q} className="px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-fg">{f.q}</summary>
                <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <nav aria-label="Compilers and tools" className="mt-10 border-t border-line-strong/60 pt-6 text-[13px] text-fg-subtle">
          <ul className="flex flex-wrap gap-x-4 gap-y-2">
            {LANDING_PAGES.map((p) => (
              <li key={p.slug}>
                <a href={`/${p.slug}`} className="hover:text-fg hover:underline">
                  {p.kind === "language" ? `Online ${p.label}` : p.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}

/** A name not used yet: "Java project", then "Java project 2", ... */
export function suggestName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Asks what to call a new project before it is made and opened. */
function NameDialog({ language, taken, busy, onCancel, onCreate }: { language: string | null; taken: string[]; busy: boolean; onCancel: () => void; onCreate: (name: string) => void }) {
  const lang = language ? getLanguage(language) : undefined;
  // A suggestion, selected, so typing replaces it and Enter accepts it.
  const [name, setName] = useState(() => (lang ? suggestName(`${lang.name} project`, taken) : ""));
  const trimmed = name.trim();
  return (
    <Dialog
      open={!!lang}
      onOpenChange={(open) => !open && onCancel()}
      title={lang ? `New ${lang.name} project` : "New project"}
      description="Give the project a name. You can change it later."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !busy) onCreate(trimmed);
        }}
      >
        <div className="flex items-center gap-3">
          {lang && <LanguageMark id={lang.id} size={36} />}
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} placeholder="Project name" aria-label="Project name" className="h-9 flex-1" />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!trimmed || busy}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const VERDICT: Record<NonNullable<NonNullable<ProjectSummary["interview"]>["verdict"]>["status"], string> = {
  accepted: "Accepted",
  "wrong-answer": "Wrong answer",
  "runtime-error": "Runtime error",
  "time-limit": "Time limit exceeded",
  "compile-error": "Did not compile",
  error: "Not checked",
};

/** An interview given from this browser: who, when, how it went. Opening it shows its overview, report and replay. */
function InterviewCard({ project }: { project: ProjectSummary }) {
  const { openProject, deleteProject } = useWorkspace.getState();
  const [confirm, setConfirm] = useState(false);
  const iv = project.interview!;
  const state = iv.endedAt ? "Finished" : iv.startedAt ? "In progress" : "Not started";
  const when = iv.startedAt ?? project.updatedAt;
  const v = iv.verdict;
  const score = v && v.total > 0 && v.status !== "compile-error" && v.status !== "error" ? ` · ${v.passed}/${v.total} tests` : "";
  return (
    <li className="group relative rounded-xl border border-line-strong bg-surface transition-colors hover:border-fg-faint">
      <button onClick={() => void openProject(project.id)} className="flex w-full items-start gap-3 p-4 pr-12 text-left">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-accent/15 text-accent">
          <ClipboardList className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-fg">{iv.title}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-sm text-fg-subtle">
            <LanguageMark id={project.language} size={14} className="rounded-[3px]" />
            <span className="truncate">{iv.candidate ?? "No candidate yet"}</span>
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {v ? (
              <span className={cn("font-medium", v.status === "accepted" ? "text-success" : v.status === "error" ? "text-warning" : "text-danger")}>
                {VERDICT[v.status]}
                {score}
              </span>
            ) : (
              <span className={cn("font-medium", iv.endedAt ? "text-fg-muted" : "text-warning")}>{iv.endedAt ? "Nothing submitted" : state}</span>
            )}
            {iv.flags > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <ShieldAlert className="size-3" />
                {iv.flags} to look at
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs text-fg-subtle">
            {v ? `${state} · ` : ""}
            {new Date(when).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, {new Date(when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </span>
      </button>
      <div className="absolute right-2 top-2">
        <DropdownMenu
          align="end"
          trigger={
            <IconButton label={`Actions for the interview ${iv.title}`} className="opacity-60 group-hover:opacity-100 data-[state=open]:opacity-100">
              <MoreHorizontal />
            </IconButton>
          }
          entries={[
            { label: "Open", icon: <FolderOpen />, onSelect: () => void openProject(project.id) },
            { kind: "separator" },
            { label: "Delete…", icon: <Trash2 />, danger: true, onSelect: () => setConfirm(true) },
          ]}
        />
      </div>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete the interview “${iv.title}”?`}
        description="The candidate's code, the activity, your notes and the recording are removed from this browser. This cannot be undone."
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
