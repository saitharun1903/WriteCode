"use client";

import { ArrowRight, ClipboardList, Copy, FolderOpen, Hourglass, MoreHorizontal, Pencil, Plus, Search, ShieldAlert, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { LANGUAGES, PRODUCT, getLanguage, type ProjectSummary } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/menu";
import { Input } from "@/components/ui/primitives";
import { ProjectBadge } from "@/features/explorer/file-icon";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";
import { HOME_FAQS, LANDING_PAGES } from "@/features/seo/pages";
import { useInterviewUI } from "@/features/interview/ui";
import { TransferButton } from "@/features/export/ExportUI";
import { FeatureDeck } from "./FeatureDeck";
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

  const temporary = useWorkspace((s) => s.temporaryMode);

  const create = async (id: string, name: string) => {
    setBusy(id);
    await createProject(id, name, { temporary });
    setBusy(null);
    setNaming(null);
  };
  /** A temporary project needs no name: it is gone when it is closed. */
  const pick = (id: string) => (temporary ? void create(id, `${getLanguage(id)?.name ?? "Temporary"} project`) : setNaming(id));

  return (
    <div className="h-full overflow-y-auto bg-surface-2">
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-10">
          <h1 className="text-[32px] font-bold leading-none tracking-[-0.03em] text-fg sm:text-[38px]" style={{ fontFamily: 'var(--font-code-jetbrains), "Cascadia Mono", Consolas, monospace' }}>
            {PRODUCT.name}
            <span aria-hidden className="cw-caret" />
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-snug text-fg-muted">
            Free online compiler, debugger and visualizer for {LANGUAGES.slice(0, -1).map((l) => l.name).join(", ")} and {LANGUAGES[LANGUAGES.length - 1]!.name}.
          </p>
          <p className="mt-2 font-mono text-xs text-fg-subtle">no sign-up · nothing to install · saved in this browser</p>
        </header>

        <section aria-labelledby="new-heading">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <h2 id="new-heading" className="text-xl font-semibold tracking-tight text-fg">
              New project
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={temporary}
                aria-label="Temporary project"
                title="A temporary project is not saved: it is erased when you close it"
                onClick={() => useWorkspace.getState().setTemporaryMode(!temporary)}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-full border pl-3 pr-1.5 text-[13px] font-medium transition-colors",
                  temporary ? "border-accent bg-accent-soft text-fg" : "border-line-strong text-fg-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Hourglass className={cn("size-3.5", temporary && "text-accent-ink")} />
                Temporary
                <span className={cn("relative ml-0.5 h-6 w-10 rounded-full transition-colors", temporary ? "bg-accent" : "bg-surface-3")}>
                  <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full shadow-sm transition-transform duration-150", temporary ? "translate-x-4 bg-accent-fg" : "bg-fg-subtle")} />
                </span>
              </button>
              <Button variant="secondary" className="h-9 rounded-full px-3.5" icon={<Plus className="size-4" />} onClick={() => useUI.getState().setNewProjectOpen(true)}>
                Custom…
              </Button>
            </div>
          </div>
          {temporary && (
            <div role="status" className="mt-4 flex items-start gap-3 rounded-xl border border-dashed border-accent bg-accent-soft/40 px-4 py-3">
              <Hourglass className="mt-0.5 size-4 shrink-0 text-accent-ink" />
              <p className="text-[13px] leading-relaxed text-fg-muted">
                <b className="font-semibold text-fg">Temporary is on.</b> Pick a language and start typing. Nothing is saved and no history is kept: the project is erased when you close it or leave the page. If you want it after all, keep it from the Temporary button at the top of the editor.
              </p>
            </div>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.id}
                aria-label={`New ${lang.name} project`}
                disabled={!!busy}
                onClick={() => pick(lang.id)}
                className={cn(
                  "group flex items-center gap-4 rounded-xl border bg-surface p-4 text-left transition-[border-color,transform] duration-150",
                  "hover:-translate-y-0.5 hover:border-accent disabled:opacity-60",
                  temporary ? "border-dashed border-accent/60" : "border-line-strong",
                )}
              >
                <LanguageMark id={lang.id} size={46} />
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-semibold text-fg">{lang.name}</span>
                  <span className="block truncate text-sm text-fg-subtle">{temporary ? "Not saved" : lang.version}</span>
                </span>
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors group-hover:bg-accent group-hover:text-accent-fg">
                  {temporary ? <Hourglass className="size-3.5" /> : <ArrowRight className="size-4" />}
                </span>
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

        <section aria-labelledby="recent-heading" className="mt-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="recent-heading" className="text-xl font-semibold tracking-tight text-fg">
              Recent projects {projects.length > 0 && <span className="ml-1 font-mono text-sm font-normal text-fg-subtle">{projects.length}</span>}
            </h2>
            <TransferButton className="sm:ml-auto" />
            {projects.length > 0 && (
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="h-8 pl-8" />
              </div>
            )}
          </div>
          {projects.length > 0 ? (
            <>
              <ul aria-label="Recent projects" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </ul>
              {filtered.length === 0 && <p className="py-8 text-center text-sm text-fg-subtle">No projects match “{query}”.</p>}
            </>
          ) : (
            <Empty icon={<FolderOpen className="size-5" />}>Nothing here yet. A project shows up once you run it or change its code, and it stays saved in this browser.</Empty>
          )}
        </section>

        <section aria-labelledby="interviews-heading" className="mt-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="interviews-heading" className="text-xl font-semibold tracking-tight text-fg">
              Interviews {interviews.length > 0 && <span className="ml-1 font-mono text-sm font-normal text-fg-subtle">{interviews.length}</span>}
            </h2>
            <Button variant="secondary" className="h-8 rounded-full px-3.5" icon={<Plus className="size-4" />} onClick={() => useInterviewUI.getState().openSetup("create")}>
              New interview
            </Button>
          </div>
          {interviews.length > 0 ? (
            <ul aria-label="Interviews" className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {interviews.map((p) => (
                <InterviewCard key={p.id} project={p} />
              ))}
            </ul>
          ) : (
            <Empty icon={<ClipboardList className="size-5" />}>No interviews yet. Set a question with hidden tests and send the candidate a link. Afterwards their code, your notes and the report are kept here.</Empty>
          )}
        </section>

        <section aria-labelledby="about-heading" className="mt-16">
          <h2 id="about-heading" className="text-xl font-semibold tracking-tight text-fg">
            What’s inside
          </h2>
          <FeatureDeck />
        </section>

        <section aria-labelledby="faq-heading" className="mt-12">
          <h2 id="faq-heading" className="text-xl font-semibold tracking-tight text-fg">
            Questions and answers
          </h2>
          <div className="mt-4 divide-y divide-line-strong/60 rounded-xl border border-line-strong bg-surface">
            {HOME_FAQS.map((f) => (
              <details key={f.q} className="group px-4 py-3.5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium text-fg [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <Plus className="size-4 shrink-0 text-fg-subtle transition-transform group-open:rotate-45" />
                </summary>
                <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-fg-muted">{f.a}</p>
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

/** A list with nothing in it yet: what will appear there. */
function Empty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4 flex items-center gap-3.5 rounded-xl border border-dashed border-line-strong px-4 py-4 text-fg-subtle">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-fg-muted">{icon}</span>
      <p className="max-w-2xl text-[13px] leading-relaxed">{children}</p>
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
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-ink">
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
