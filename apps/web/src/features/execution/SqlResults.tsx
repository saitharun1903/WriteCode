"use client";

import { Check, CircleAlert, Copy, Download, ListChecks, Table2, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { goToLocation } from "@/features/editor/navigate";
import { isNumeric, parseSqlOutput, type SqlBlock } from "./sql-output";
import { isRunning, type RunState } from "./store";

type Table = Extract<SqlBlock, { kind: "table" }>;

/** Rows drawn at once; a longer result says how many more there are (the whole of it is in the CSV). */
const MAX_ROWS = 500;

/** The table a query reads, when it reads one: the name of its result. */
function sourceOf(sql: string): string | null {
  const m = /\bfrom\s+(?:[`"]([^`"]+)[`"]|([A-Za-z_][\w$]*))/i.exec(sql);
  const describe = /^(?:describe|desc)\s+[`"]?([\w$]+)/i.exec(sql);
  return describe ? `${describe[1]} · structure` : m ? (m[1] ?? m[2] ?? null) : null;
}

const csvCell = (v: string) => (v === "NULL" ? "" : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function download(name: string, table: Table) {
  const csv = [table.columns, ...table.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^\w.-]+/g, "_") || "result"}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A result as a database tool shows it: a grid that fills the panel, its header and row numbers staying in view. */
function Grid({ table, index, name }: { table: Table; index: number; name: string }) {
  const numeric = useMemo(() => table.columns.map((_, c) => isNumeric(table.rows, c)), [table]);
  const [copied, setCopied] = useState(false);
  const shown = table.rows.slice(0, MAX_ROWS);
  const head = "sticky top-0 z-10 border-b border-r border-line-strong bg-surface-3 px-3 py-1.5 font-semibold text-fg whitespace-nowrap";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([table.columns, ...table.rows].map((r) => r.join("\t")).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      <div className="min-h-0 flex-1 overflow-auto bg-surface-2">
        <table aria-label={`Result ${index}`} className="border-separate border-spacing-0 text-left text-[13px] leading-5">
          <thead>
            <tr>
              <td className={cn(head, "left-0 z-20 w-10 text-right font-normal text-fg-faint")} />
              {table.columns.map((c, i) => (
                <th key={i} scope="col" className={cn(head, numeric[i] && "text-right")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono text-[12.5px]">
            {shown.map((row, r) => (
              <tr key={r} className="group">
                <td className="sticky left-0 border-b border-r border-line bg-surface-3 px-2 py-1 text-right align-top text-[11px] tabular-nums text-fg-faint">{r + 1}</td>
                {row.map((v, i) => (
                  <td
                    key={i}
                    className={cn(
                      "max-w-[28rem] whitespace-pre-wrap break-words border-b border-r border-line bg-surface px-3 py-1 align-top text-fg group-hover:bg-hover",
                      numeric[i] && "text-right tabular-nums",
                      v === "NULL" && "italic text-fg-faint",
                    )}
                  >
                    {v}
                  </td>
                ))}
              </tr>
            ))}
            {table.rows.length === 0 && table.complete && (
              <tr>
                <td className="sticky left-0 border-b border-r border-line bg-surface-3" />
                <td colSpan={table.columns.length} className="border-b border-r border-line bg-surface px-3 py-2 font-sans text-[13px] text-fg-subtle">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-xs text-fg-subtle">
        <span className="tabular-nums">
          {table.complete ? `${table.rows.length} row${table.rows.length === 1 ? "" : "s"}` : "Loading…"}
          {table.rows.length > MAX_ROWS && ` · the first ${MAX_ROWS} are shown`}
        </span>
        <span className="tabular-nums">
          {table.columns.length} column{table.columns.length === 1 ? "" : "s"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={copy} className="flex h-6 items-center gap-1 rounded-[4px] px-1.5 hover:bg-hover hover:text-fg">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={() => download(name, table)} className="flex h-6 items-center gap-1 rounded-[4px] px-1.5 hover:bg-hover hover:text-fg">
            <Download className="size-3.5" />
            CSV
          </button>
        </span>
      </div>
    </div>
  );
}

const ms = (n: number) => (n < 1 ? "<1 ms" : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);

/** What every statement of the run did, in the order they ran. */
export function StatementList({ run, notes }: { run: RunState; notes: string[] }) {
  const list = run.statements;
  if (!list?.length) {
    // Still running (or a run that reports nothing more): what the statements printed about themselves.
    return notes.map((text, i) => (
      <p key={i} className="flex items-center gap-1.5 font-sans text-[13px] leading-6 text-fg-muted">
        <Check className="size-3.5 shrink-0 text-success" />
        {text}
      </p>
    ));
  }
  const links = !run.query;
  return (
    <table aria-label="Statements" className="mb-2 w-full border-collapse font-sans text-[13px] leading-5">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wider text-fg-faint">
          <th className="w-6 pb-1 font-semibold" />
          <th className="w-12 pb-1 pr-3 text-right font-semibold">Line</th>
          <th className="pb-1 pr-4 font-semibold">Statement</th>
          <th className="pb-1 pr-4 font-semibold">Result</th>
          <th className="w-16 pb-1 text-right font-semibold">Time</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s, i) => (
          <tr key={i} className={cn("border-t border-line align-top", !s.ok && "bg-danger-soft")}>
            <td className="py-1">{s.ok ? <Check className="mt-0.5 size-3.5 text-success" /> : <X className="mt-0.5 size-3.5 text-danger" />}</td>
            <td className="py-1 pr-3 text-right font-mono text-xs tabular-nums text-fg-subtle">
              {links ? (
                <button type="button" title={`Open line ${s.line}`} onClick={() => goToLocation(run.entry, s.line)} className="underline decoration-current/40 underline-offset-2 hover:text-accent-ink">
                  {s.line}
                </button>
              ) : (
                s.line
              )}
            </td>
            <td className="max-w-0 truncate py-1 pr-4 font-mono text-[12.5px] text-fg" title={s.sql}>
              {s.sql}
            </td>
            <td className={cn("whitespace-normal py-1 pr-4", s.ok ? "text-fg-muted" : "text-danger")}>{s.message}</td>
            <td className="whitespace-nowrap py-1 text-right font-mono text-xs tabular-nums text-fg-subtle">{ms(s.ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The output of a SQL run, laid out as in a database tool: a tab for the rows
 * of each query, and one (Output) for what every statement did and any error.
 * `output` draws that last tab; it is given the notes the statements printed.
 */
export function SqlRunView({ run, printed, output }: { run: RunState; printed: string; output: (notes: string[]) => ReactNode }) {
  const blocks = useMemo(() => parseSqlOutput(printed), [printed]);
  const tables = useMemo(() => blocks.filter((b): b is Table => b.kind === "table"), [blocks]);
  const notes = useMemo(() => blocks.filter((b) => b.kind !== "table").map((b) => b.text), [blocks]);
  // The i-th statement that returned rows made the i-th table: it is named after the table it read.
  const names = useMemo(() => {
    const queries = (run.statements ?? []).filter((s) => s.ok && /^\d+ rows? returned$/.test(s.message));
    const named = tables.map((_, i) => (queries.length === tables.length ? sourceOf(queries[i]!.sql) : null) ?? (run.query && tables.length === 1 ? run.title : null) ?? `Result ${i + 1}`);
    // Several queries on one table: students 1, students 2.
    return named.map((name, i) => (named.filter((n) => n === name).length > 1 ? `${name} ${named.slice(0, i + 1).filter((n) => n === name).length}` : name));
  }, [run.statements, run.query, run.title, tables]);

  const failed = !!run.error || (!!run.result && run.result.status !== "SUCCESS");
  const [picked, setPicked] = useState<number | "output" | null>(null);
  // Until a tab is chosen: the error when there is one, else the rows of the last query.
  const fallback = failed || tables.length === 0 ? "output" : tables.length - 1;
  const tab = picked !== null && (picked === "output" || picked < tables.length) ? picked : fallback;
  const count = run.statements?.length;
  const tabClass = (on: boolean) =>
    cn(
      "relative flex h-full shrink-0 items-center gap-1.5 px-2.5 text-[13px] transition-colors [[data-touch]_&]:px-3",
      on ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-fg-subtle hover:text-fg",
    );

  return (
    <div role="region" aria-label="Program output" className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Results" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface px-1 font-sans [[data-touch]_&]:h-10">
        {tables.map((t, i) => (
          <button key={i} type="button" role="tab" aria-selected={tab === i} onClick={() => setPicked(i)} className={tabClass(tab === i)}>
            <Table2 className="size-3.5 shrink-0" />
            <span className="max-w-40 truncate">{names[i]}</span>
            <span className="font-mono text-[11px] tabular-nums text-fg-faint">{t.rows.length}</span>
          </button>
        ))}
        <button type="button" role="tab" aria-selected={tab === "output"} onClick={() => setPicked("output")} className={cn(tabClass(tab === "output"), tables.length > 0 && "ml-auto")}>
          {failed ? <CircleAlert className="size-3.5 shrink-0 text-danger" /> : <ListChecks className="size-3.5 shrink-0" />}
          Output
          {count !== undefined && !isRunning(run) && <span className="font-mono text-[11px] tabular-nums text-fg-faint">{count}</span>}
        </button>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {tab === "output" ? output(notes) : <Grid key={tab} table={tables[tab]!} index={tab + 1} name={names[tab]!} />}
      </div>
    </div>
  );
}
