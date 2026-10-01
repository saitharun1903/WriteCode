import type { HistoryEntry, ProjectFile } from "@cw/shared";

/** Identifies a version of a program: the file it starts from and every file's text. */
export function codeKey(entry: Pick<HistoryEntry, "entryFile" | "files">): string {
  return JSON.stringify([entry.entryFile, [...entry.files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content])]);
}

export const sameCode = (a: Pick<HistoryEntry, "entryFile" | "files">, b: Pick<HistoryEntry, "entryFile" | "files">) => codeKey(a) === codeKey(b);

/** A version of the code in the history: its latest run, and how often it ran. */
export interface RunVersion {
  entry: HistoryEntry;
  runs: number;
  /** When this code first ran. */
  firstRunAt: number;
  /** Other stored entries with the same code (runs recorded before they were merged). */
  duplicates: string[];
}

/**
 * History as versions of the code, newest first: running the same code again
 * is not a new entry, it only moves that version to the top with its latest
 * result. `entries` are newest first.
 */
export function versions(entries: HistoryEntry[]): RunVersion[] {
  const byCode = new Map<string, RunVersion>();
  const out: RunVersion[] = [];
  for (const entry of entries) {
    const key = `${entry.projectId}\n${codeKey(entry)}`;
    const known = byCode.get(key);
    const first = entry.firstRunAt ?? entry.createdAt;
    if (known) {
      known.runs += entry.runs ?? 1;
      known.firstRunAt = Math.min(known.firstRunAt, first);
      known.duplicates.push(entry.id);
      continue;
    }
    const version = { entry, runs: entry.runs ?? 1, firstRunAt: first, duplicates: [] };
    byCode.set(key, version);
    out.push(version);
  }
  return out;
}

export interface Change {
  added: number;
  removed: number;
  /** Files that differ, were added or were removed. */
  files: string[];
}

function lineDiff(before: string, after: string): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const line of before.split("\n")) count.set(line, (count.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split("\n")) {
    const left = count.get(line) ?? 0;
    if (left > 0) count.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of count.values()) removed += left;
  return { added, removed };
}

/** What changed in the code from `before` to `after`, in lines. Null when nothing did. */
export function changeBetween(before: ProjectFile[], after: ProjectFile[]): Change | null {
  const old = new Map(before.map((f) => [f.path, f.content]));
  const change: Change = { added: 0, removed: 0, files: [] };
  for (const f of after) {
    const was = old.get(f.path);
    old.delete(f.path);
    if (was === f.content) continue;
    const d = lineDiff(was ?? "", f.content);
    // A new file's lines are all additions (an empty "before" is one empty line, not a removal).
    change.added += d.added;
    change.removed += was === undefined ? 0 : d.removed;
    change.files.push(f.path);
  }
  for (const [path, content] of old) {
    change.removed += content.split("\n").length;
    change.files.push(path);
  }
  return change.files.length ? change : null;
}

/** For each version, what changed since the version of the same project that ran before it. */
export function changes(list: RunVersion[]): Map<string, Change | "first"> {
  const out = new Map<string, Change | "first">();
  // Oldest first by when each version first ran, per project.
  const byProject = new Map<string, RunVersion[]>();
  for (const v of list) byProject.set(v.entry.projectId, [...(byProject.get(v.entry.projectId) ?? []), v]);
  for (const group of byProject.values()) {
    const ordered = [...group].sort((a, b) => a.firstRunAt - b.firstRunAt);
    for (const [i, v] of ordered.entries()) {
      const change = i === 0 ? "first" : changeBetween(ordered[i - 1]!.entry.files, v.entry.files);
      if (change) out.set(v.entry.id, change);
    }
  }
  return out;
}

/** One line that says what the run did: the first line it printed, or why it failed. */
export function outputPreview(entry: HistoryEntry): { text: string; error: boolean } | null {
  const r = entry.result;
  const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean);
  if (r.status === "COMPILATION_ERROR") {
    const line = r.compileOutput.split("\n").map((l) => l.trim()).find((l) => /error/i.test(l)) ?? firstLine(r.compileOutput);
    return line ? { text: line, error: true } : null;
  }
  if (r.status !== "SUCCESS") {
    // The last line of a stack trace names the error.
    const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    const line = lines.find((l) => /^(Exception in thread|[\w.$]+(Error|Exception)\b)/.test(l)) ?? lines.at(-1) ?? r.message;
    if (line) return { text: line, error: true };
  }
  const line = firstLine(r.stdout);
  return line ? { text: line, error: false } : null;
}

/** "just now", "5 min ago", "2 h ago"; an older time is shown as the time of day. */
export function ago(ts: number, now = Date.now()): string | null {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 6 * 3600) return `${Math.round(s / 3600)} h ago`;
  return null;
}
