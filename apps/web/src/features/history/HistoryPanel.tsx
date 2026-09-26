"use client";

import { Camera, GitCompareArrows, History as HistoryIcon, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getLanguage, type HistoryEntry, type Snapshot } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/menu";
import { EmptyState, PanelHeader, Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { StatusPill, formatDuration } from "@/features/execution/status";
import { useExecution } from "@/features/execution/store";
import { historyRepo, projectRepo } from "@/features/projects/db";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { useSnapshots } from "./snapshot-store";

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (startOf(today) - startOf(d)) / 86_400_000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function groupByDay<T extends { createdAt: number }>(items: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = dayLabel(item.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups];
}

export function HistoryPanel() {
  const [tab, setTab] = useState<"runs" | "snapshots">("runs");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="History" />
      <div role="tablist" className="mx-3 mb-2 grid shrink-0 grid-cols-2 rounded-md bg-surface-3 p-0.5 text-xs">
        {(["runs", "snapshots"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("h-6 rounded-[5px] capitalize", tab === t ? "bg-surface-2 text-fg shadow-sm" : "text-fg-subtle hover:text-fg-muted")}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "runs" ? <RunHistory /> : <Snapshots />}</div>
    </div>
  );
}

function RunHistory() {
  const version = useExecution((s) => s.historyVersion);
  const bump = useExecution((s) => s.bumpHistory);
  const currentProjectId = useWorkspace((s) => s.project?.id);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyThisProject, setOnlyThisProject] = useState(true);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await historyRepo.list());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read history.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    historyRepo.list().then(
      (list) => {
        if (cancelled) return;
        setEntries(list);
        setError(null);
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not read history."),
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  const visible = useMemo(
    () => (entries ?? []).filter((e) => !onlyThisProject || !currentProjectId || e.projectId === currentProjectId),
    [entries, onlyThisProject, currentProjectId],
  );

  if (error) return <EmptyState title="History unavailable" description={error} action={<Button size="sm" onClick={load}>Retry</Button>} />;
  if (!entries) return <div className="flex justify-center p-6 text-fg-subtle"><Spinner /></div>;

  return (
    <>
      {currentProjectId && (
        <label className="flex items-center gap-2 px-3 pb-2 text-xs text-fg-subtle">
          <input type="checkbox" checked={onlyThisProject} onChange={(e) => setOnlyThisProject(e.target.checked)} className="accent-[var(--accent)]" />
          Only this project
        </label>
      )}
      {visible.length === 0 ? (
        <EmptyState icon={<HistoryIcon />} title="No runs yet" description="Every run is recorded here with its code, input and output." />
      ) : (
        groupByDay(visible).map(([day, items]) => (
          <section key={day} className="pb-2">
            <h3 className="sticky top-0 z-[1] bg-surface px-3 py-1 text-xs font-semibold text-fg-subtle">{day}</h3>
            <ul>
              {items.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => setSelected(e)}
                    className="flex w-full flex-col gap-1 px-3 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
                  >
                    <span className="flex w-full items-center gap-2 text-sm">
                      <span className="font-mono text-xs tabular-nums text-fg-subtle">{timeLabel(e.createdAt)}</span>
                      <span className="text-fg">{getLanguage(e.language)?.name ?? e.language}</span>
                      <span className="ml-auto truncate text-xs text-fg-subtle">{formatDuration(e.result.executionTime)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusPill status={e.result.status} className="h-4 px-1 text-2xs" />
                      <span className="truncate text-xs text-fg-subtle">
                        {e.projectName} · {e.entryFile}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {selected && <HistoryDetail entry={selected} onClose={() => setSelected(null)} onDeleted={bump} />}
    </>
  );
}

function HistoryDetail({ entry, onClose, onDeleted }: { entry: HistoryEntry; onClose: () => void; onDeleted: () => void }) {
  const current = useWorkspace((s) => s.project);
  const r = entry.result;
  const isCurrent = current?.id === entry.projectId;

  const restore = async () => {
    const ws = useWorkspace.getState();
    if (!isCurrent) {
      const exists = await projectRepo.get(entry.projectId);
      if (!exists) {
        await ws.createProject(entry.language, `${entry.projectName} (restored)`);
        useWorkspace.getState().replaceFiles(entry.files, entry.entryFile);
        onClose();
        return toast.success("Restored into a new project");
      }
      await ws.openProject(entry.projectId);
    }
    await useSnapshots.getState().restore({ files: entry.files, label: `run from ${timeLabel(entry.createdAt)}` });
    useWorkspace.getState().setEntryFile(entry.entryFile);
    onClose();
  };

  const compare = () => {
    useSnapshots.getState().openCompare({ title: `Run at ${timeLabel(entry.createdAt)} ↔ current`, files: entry.files });
    onClose();
  };

  const remove = async () => {
    await historyRepo.delete(entry.id);
    onDeleted();
    onClose();
  };

  const output = [r.compileOutput, r.stdout, r.stderr].filter(Boolean).join("\n");

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${entry.projectName} · ${entry.entryFile}`}
      description={`${dayLabel(entry.createdAt)} at ${timeLabel(entry.createdAt)} · ${getLanguage(entry.language)?.name ?? entry.language} ${r.runtimeVersion}`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={remove} className="mr-auto">
            Delete
          </Button>
          <Button icon={<GitCompareArrows className="size-3.5" />} onClick={compare} disabled={!isCurrent}>
            Compare with current
          </Button>
          <Button variant="primary" icon={<RotateCcw className="size-3.5" />} onClick={restore}>
            Restore code
          </Button>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-fg-subtle">
        <StatusPill status={r.status} />
        {r.exitCode !== undefined && <span>exit {r.exitCode}</span>}
        {r.executionTime !== undefined && <span>{formatDuration(r.executionTime)}</span>}
        <span>{entry.files.length} file{entry.files.length === 1 ? "" : "s"}</span>
      </div>
      {entry.stdin && (
        <details className="mb-2 text-xs">
          <summary className="cursor-default text-fg-subtle">Input (stdin)</summary>
          <pre className="mt-1 max-h-24 overflow-auto rounded-sm bg-surface p-2 font-mono text-fg-muted">{entry.stdin}</pre>
        </details>
      )}
      <pre className="max-h-72 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-fg">
        {output || <span className="text-fg-subtle">No output.</span>}
      </pre>
      {!isCurrent && <p className="mt-2 text-xs text-fg-subtle">This run belongs to another project. Restoring opens that project first.</p>}
    </Dialog>
  );
}

function Snapshots() {
  const project = useWorkspace((s) => s.project);
  const { snapshots, status, load, create, remove, restore, openCompare } = useSnapshots();
  const [confirm, setConfirm] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (project) void load(project.id);
  }, [project?.id, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!project) return <EmptyState title="Open a project to see its snapshots" />;

  return (
    <div>
      <div className="px-3 pb-2">
        <Button size="sm" className="w-full" icon={<Camera className="size-3.5" />} onClick={() => create()}>
          Save snapshot
        </Button>
      </div>
      {status === "loading" && <div className="flex justify-center p-4 text-fg-subtle"><Spinner /></div>}
      {status === "ready" && snapshots.length === 0 && (
        <EmptyState icon={<Camera />} title="No snapshots" description="Snapshots are named versions of the whole project you can diff against and restore." />
      )}
      <ul>
        {snapshots.map((s) => (
          <li key={s.id} className="group flex items-center gap-2 px-3 py-1.5 hover:bg-hover">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-fg">{s.label}</p>
              <p className="text-xs text-fg-subtle">
                {dayLabel(s.createdAt)} {timeLabel(s.createdAt)} · {s.files.length} file{s.files.length === 1 ? "" : "s"}
              </p>
            </div>
            <DropdownMenu
              align="end"
              trigger={
                <IconButton label="Snapshot actions" size="sm" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100">
                  <MoreHorizontal />
                </IconButton>
              }
              entries={[
                { label: "Compare with current", icon: <GitCompareArrows />, onSelect: () => openCompare({ title: `${s.label} ↔ current`, files: s.files }) },
                { label: "Restore", icon: <RotateCcw />, onSelect: () => setConfirm(s) },
                { kind: "separator" },
                { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => void remove(s.id) },
              ]}
            />
          </li>
        ))}
      </ul>
      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Restore ${confirm?.label}?`}
        description="The current files are saved as a snapshot first, so you can undo this."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                if (confirm) void restore(confirm);
                setConfirm(null);
              }}
            >
              Restore
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </div>
  );
}
