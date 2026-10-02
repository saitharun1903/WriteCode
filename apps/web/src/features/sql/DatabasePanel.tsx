"use client";

import { ChevronRight, Copy, Database, Eraser, Eye, KeyRound, Link2, ListTree, Rows3, Table2, Trash2 } from "lucide-react";
import { useState } from "react";
import type { SqlObject } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ContextMenu, type MenuEntry } from "@/components/ui/menu";
import { PanelHeader } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { isOwnRun, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useUI } from "@/features/workspace/ui-store";
import { cn } from "@/lib/cn";

/** A name as SQL reads it whatever is in it. */
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Runs a statement on the project's database without it being part of a file. */
function query(title: string, sql: string) {
  useUI.getState().setDrawer("none");
  void useExecution.getState().execute({ query: { title, sql } });
}

export const showRows = (name: string) => query(name, `SELECT * FROM ${quoted(name)} LIMIT 500;`);

function ObjectRow({ object, open, onToggle, busy, onDrop }: { object: SqlObject; open: boolean; onToggle: () => void; busy: boolean; onDrop: () => void }) {
  const view = object.kind === "view";
  const entries: MenuEntry[] = [
    { label: "Show Rows", icon: <Rows3 />, disabled: busy, onSelect: () => showRows(object.name) },
    ...(view ? [] : [{ label: "Show Structure", icon: <ListTree />, disabled: busy, onSelect: () => query(`${object.name} · structure`, `DESCRIBE ${quoted(object.name)};`) }]),
    {
      label: "Copy Name",
      icon: <Copy />,
      onSelect: () =>
        navigator.clipboard.writeText(object.name).then(
          () => toast.info("Name copied", object.name),
          () => toast.error("Clipboard unavailable"),
        ),
    },
    { kind: "separator" },
    { label: view ? "Drop View…" : "Drop Table…", icon: <Trash2 />, danger: true, disabled: busy, onSelect: onDrop },
  ];
  return (
    <li>
      <ContextMenu entries={entries}>
        <div className="group flex h-7 items-center rounded-[4px] pr-1 hover:bg-hover [[data-touch]_&]:h-9">
          <button type="button" aria-expanded={open} onClick={onToggle} onDoubleClick={() => !busy && showRows(object.name)} className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-left text-sm text-fg">
            <ChevronRight className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform duration-100", open && "rotate-90")} />
            {view ? <Eye className="size-3.5 shrink-0 text-[#b48ead]" /> : <Table2 className="size-3.5 shrink-0 text-accent-ink" />}
            <span className="truncate">{object.name}</span>
          </button>
          {object.rows !== null && (
            <span title={`${object.rows} row${object.rows === 1 ? "" : "s"}`} className="shrink-0 px-1 font-mono text-[11px] tabular-nums text-fg-faint">
              {object.rows}
            </span>
          )}
          <IconButton label={`Show the rows of ${object.name}`} size="sm" disabled={busy} className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [[data-touch]_&]:opacity-100" onClick={() => showRows(object.name)}>
            <Rows3 />
          </IconButton>
        </div>
      </ContextMenu>
      {open && (
        <ul aria-label={`Columns of ${object.name}`} className="mb-1 ml-[22px] border-l border-line pl-2">
          {object.columns.map((c) => (
            <li key={c.name} title={[c.pk && "Primary key", c.ref && `Refers to ${c.ref}`, c.notNull && "NOT NULL"].filter(Boolean).join(" · ") || undefined} className="flex h-6 items-center gap-1.5 pr-2 text-[13px]">
              {c.pk ? <KeyRound className="size-3 shrink-0 text-warning" /> : c.ref ? <Link2 className="size-3 shrink-0 text-accent-ink" /> : <span className="flex size-3 shrink-0 items-center justify-center"><span className="size-1 rounded-full bg-fg-faint" /></span>}
              <span className="truncate text-fg-muted">{c.name}</span>
              <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] lowercase text-fg-faint">{c.type || "any"}</span>
            </li>
          ))}
          {object.columns.length === 0 && <li className="h-6 text-[13px] leading-6 text-fg-faint">No columns</li>}
        </ul>
      )}
    </li>
  );
}

/**
 * The database of a SQL project, as a database tool shows it: its tables and
 * views, their columns, and how many rows each has. It is what the project's
 * runs have made, kept from one run to the next.
 */
export function DatabasePanel() {
  const database = useWorkspace((s) => s.project?.database);
  const busy = useExecution((s) => isOwnRun(s.run));
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [resetting, setResetting] = useState(false);
  const [dropping, setDropping] = useState<SqlObject | null>(null);

  const all = database?.tables ?? [];
  const tables = all.filter((t) => t.kind === "table");
  const views = all.filter((t) => t.kind === "view");
  const name = database?.current ?? database?.names[0] ?? "main";
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const group = (label: string, list: SqlObject[]) =>
    list.length > 0 && (
      <section aria-label={label}>
        <h3 className="flex h-6 items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          {label}
          <span className="font-mono font-normal">{list.length}</span>
        </h3>
        <ul className="px-1">
          {list.map((t) => (
            <ObjectRow key={`${t.kind}:${t.name}`} object={t} open={open.has(`${t.kind}:${t.name}`)} onToggle={() => toggle(`${t.kind}:${t.name}`)} busy={busy} onDrop={() => setDropping(t)} />
          ))}
        </ul>
      </section>
    );

  return (
    <section aria-label="Database" className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Database"
        actions={
          <IconButton label="Empty the database" size="sm" disabled={busy || !database} onClick={() => setResetting(true)}>
            <Eraser />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <div className="mx-1 flex h-7 items-center gap-1.5 rounded-[4px] px-2 text-sm text-fg">
          <Database className="size-3.5 shrink-0 text-success" />
          <span className="truncate font-medium">{name}</span>
          <span className="ml-auto shrink-0 text-[11px] text-fg-faint">SQLite</span>
        </div>
        {all.length === 0 ? (
          <p className="px-3 pt-2 text-[13px] leading-relaxed text-fg-subtle">
            No tables yet. Run a CREATE TABLE statement and the table shows up here with its columns. The database keeps its tables and rows from one run to the next.
          </p>
        ) : (
          <div className="mt-1 space-y-2">
            {group("Tables", tables)}
            {group("Views", views)}
          </div>
        )}
      </div>

      <Dialog
        open={resetting}
        onOpenChange={setResetting}
        title="Empty the database?"
        description={`${tables.length === 1 ? "Its table and the rows in it are" : `Its ${tables.length} tables and their rows are`} removed. Your SQL files stay as they are, and running them makes the tables again.`}
        footer={
          <>
            <Button onClick={() => setResetting(false)}>Cancel</Button>
            <Button
              variant="danger"
              autoFocus
              onClick={() => {
                useWorkspace.getState().setDatabase(undefined);
                setResetting(false);
              }}
            >
              Empty the database
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
      <Dialog
        open={!!dropping}
        onOpenChange={(v) => !v && setDropping(null)}
        title={dropping ? `Drop the ${dropping.kind} ${dropping.name}?` : ""}
        description={dropping?.kind === "view" ? "The view is removed. The tables it reads stay." : `The table and its ${dropping?.rows ?? 0} row${dropping?.rows === 1 ? "" : "s"} are removed from the database.`}
        footer={
          <>
            <Button onClick={() => setDropping(null)}>Cancel</Button>
            <Button
              variant="danger"
              autoFocus
              onClick={() => {
                if (dropping) query(`Drop ${dropping.name}`, `DROP ${dropping.kind === "view" ? "VIEW" : "TABLE"} ${quoted(dropping.name)};`);
                setDropping(null);
              }}
            >
              Drop
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </section>
  );
}
