import { SQL_STATE_MARK } from "./sql-runner.js";

/**
 * A SQL project's database between runs, and what a run reports about it.
 * The runner (sql-runner.ts) reads the first and prints the second after its
 * output; these are the two sides of that exchange.
 */

export interface SqlColumn {
  name: string;
  /** As it was declared (`VARCHAR(40)`); empty when the column has no type. */
  type: string;
  /** Part of the primary key. */
  pk?: boolean;
  notNull?: boolean;
  /** The column it refers to (`students.id`), for a foreign key. */
  ref?: string;
}

export interface SqlObject {
  name: string;
  kind: "table" | "view";
  columns: SqlColumn[];
  /** How many rows a table has; null for a view. */
  rows: number | null;
}

/** What one statement of a run did. */
export interface SqlLogEntry {
  /** The line its statement starts on. */
  line: number;
  /** The statement on one line, cut when long. */
  sql: string;
  /** What it did (`2 rows inserted into students`), or the error. */
  message: string;
  ok: boolean;
  ms: number;
}

export interface SqlDatabase {
  /** The SQLite database, deflated and in base64. Empty when it has no tables. */
  data: string;
  /** Names given with CREATE DATABASE and USE. There is one database; these name it. */
  names: string[];
  current: string | null;
  tables: SqlObject[];
}

export interface SqlReport {
  log: SqlLogEntry[];
  /** The database after the run. Absent when it could not be kept (see `tooLarge`). */
  database?: SqlDatabase;
  /** The database outgrew what a run can carry: the project keeps the one from before this run. */
  tooLarge?: boolean;
}

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readObjects(v: unknown): SqlObject[] | null {
  if (!Array.isArray(v) || v.length > 200) return null;
  const out: SqlObject[] = [];
  for (const t of v) {
    if (!obj(t) || !str(t.name, 300) || (t.kind !== "table" && t.kind !== "view") || !Array.isArray(t.columns)) return null;
    const columns: SqlColumn[] = [];
    for (const c of t.columns.slice(0, 500)) {
      if (!obj(c) || !str(c.name, 300) || !str(c.type, 300)) return null;
      columns.push({ name: c.name, type: c.type, ...(c.pk === true ? { pk: true } : {}), ...(c.notNull === true ? { notNull: true } : {}), ...(str(c.ref, 600) ? { ref: c.ref } : {}) });
    }
    out.push({ name: t.name, kind: t.kind, columns, rows: typeof t.rows === "number" && Number.isFinite(t.rows) ? t.rows : null });
  }
  return out;
}

/**
 * Separates what a SQL run printed from the report that follows it. `report`
 * is null when there is none (a run without a database, or output that was cut
 * before its end).
 */
export function splitSqlOutput(stdout: string): { text: string; report: SqlReport | null } {
  const at = stdout.indexOf(SQL_STATE_MARK);
  if (at < 0) return { text: stdout, report: null };
  const text = stdout.slice(0, at);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(at + 1));
  } catch {
    return { text, report: null };
  }
  if (!obj(raw)) return { text, report: null };
  const log: SqlLogEntry[] = [];
  for (const e of Array.isArray(raw.log) ? raw.log.slice(0, 400) : []) {
    if (obj(e) && typeof e.line === "number" && str(e.sql, 400) && str(e.message, 2000)) log.push({ line: e.line, sql: e.sql, message: e.message, ok: e.ok === true, ms: typeof e.ms === "number" ? e.ms : 0 });
  }
  const tables = readObjects(raw.tables);
  const names = Array.isArray(raw.names) ? raw.names.filter((n): n is string => str(n, 200)).slice(0, 50) : [];
  const current = str(raw.current, 200) && names.includes(raw.current) ? raw.current : null;
  if (tables && str(raw.data, 262_144) && /^[A-Za-z0-9+/=]*$/.test(raw.data)) return { text, report: { log, database: { data: raw.data, names, current, tables } } };
  return { text, report: { log, ...(raw.tooLarge === true ? { tooLarge: true } : {}) } };
}

/** The file a run reads its database from: `database` as the runs before left it, or nothing yet. */
export function sqlStateFile(database: SqlDatabase | undefined): string {
  return JSON.stringify({ data: database?.data ?? "", names: database?.names ?? [], current: database?.current ?? null });
}
