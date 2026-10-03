import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { HistoryEntry, Project, ProjectSummary, Snapshot } from "@cw/shared";
import { codeKey } from "@/features/history/runs";
import { lastActivity, summarize } from "./operations";

/**
 * Local persistence. V1 has no accounts, so projects, history and snapshots
 * live in the browser's IndexedDB. The repository shape mirrors what a server
 * API will expose later, so swapping the backing store does not touch the UI.
 */

interface WorkspaceDB extends DBSchema {
  projects: { key: string; value: Project; indexes: { updatedAt: number } };
  history: { key: string; value: HistoryEntry; indexes: { projectId: string; createdAt: number } };
  snapshots: { key: string; value: Snapshot; indexes: { projectId: string } };
}

const DB_NAME = "code-workspace";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<WorkspaceDB>> | null = null;

function db(): Promise<IDBPDatabase<WorkspaceDB>> {
  dbPromise ??= openDB<WorkspaceDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const projects = database.createObjectStore("projects", { keyPath: "id" });
      projects.createIndex("updatedAt", "updatedAt");
      const history = database.createObjectStore("history", { keyPath: "id" });
      history.createIndex("projectId", "projectId");
      history.createIndex("createdAt", "createdAt");
      const snapshots = database.createObjectStore("snapshots", { keyPath: "id" });
      snapshots.createIndex("projectId", "projectId");
    },
  });
  return dbPromise;
}

/** Test hook: close and forget the cached connection so the database can be deleted. */
export async function resetDbConnection() {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) (await pending).close();
}

export const projectRepo = {
  async list(): Promise<ProjectSummary[]> {
    const all = await (await db()).getAll("projects");
    return all.map(summarize).sort((a, b) => lastActivity(b) - lastActivity(a));
  },
  async get(id: string): Promise<Project | undefined> {
    return (await db()).get("projects", id);
  },
  async put(project: Project): Promise<void> {
    await (await db()).put("projects", project);
  },
  /** Deletes a project together with its history and snapshots. */
  async delete(id: string): Promise<void> {
    const d = await db();
    const tx = d.transaction(["projects", "history", "snapshots"], "readwrite");
    await tx.objectStore("projects").delete(id);
    for (const store of ["history", "snapshots"] as const) {
      let cursor = await tx.objectStore(store).index("projectId").openCursor(id);
      while (cursor) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
    }
    await tx.done;
  },
};

export const historyRepo = {
  /** Every run of one project, newest first. */
  async listByProject(projectId: string): Promise<HistoryEntry[]> {
    const all = await (await db()).getAllFromIndex("history", "projectId", projectId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  /** Newest first, across projects. */
  async list(limit = 2000): Promise<HistoryEntry[]> {
    const d = await db();
    const out: HistoryEntry[] = [];
    let cursor = await d.transaction("history").store.index("createdAt").openCursor(null, "prev");
    while (cursor && out.length < limit) {
      out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  },
  /** Latest run time per project that has run history. */
  async lastRunByProject(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let cursor = await (await db()).transaction("history").store.openCursor();
    while (cursor) {
      const { projectId, createdAt } = cursor.value;
      out.set(projectId, Math.max(out.get(projectId) ?? 0, createdAt));
      cursor = await cursor.continue();
    }
    return out;
  },
  async add(entry: HistoryEntry): Promise<void> {
    await (await db()).put("history", entry);
  },
  /**
   * Records a run. Running code that is already in the project's history is
   * not a new entry: that entry gets the new result and time, and counts one
   * more run. Only changed code adds an entry.
   */
  async record(entry: HistoryEntry): Promise<void> {
    const tx = (await db()).transaction("history", "readwrite");
    const key = codeKey(entry);
    let same = null as HistoryEntry | null;
    let cursor = await tx.store.index("projectId").openCursor(entry.projectId);
    while (cursor) {
      const old = cursor.value;
      if (codeKey(old) === key) {
        // Entries from before runs were merged: fold them into one.
        if (same) {
          same = { ...same, runs: (same.runs ?? 1) + (old.runs ?? 1), firstRunAt: Math.min(same.firstRunAt ?? same.createdAt, old.firstRunAt ?? old.createdAt) };
          await cursor.delete();
        } else same = old;
      }
      cursor = await cursor.continue();
    }
    await tx.store.put(same ? { ...entry, id: same.id, runs: (same.runs ?? 1) + 1, firstRunAt: same.firstRunAt ?? same.createdAt } : entry);
    await tx.done;
  },
  async deleteMany(ids: string[]): Promise<void> {
    const tx = (await db()).transaction("history", "readwrite");
    for (const id of ids) await tx.store.delete(id);
    await tx.done;
  },
  async delete(id: string): Promise<void> {
    await (await db()).delete("history", id);
  },
  async clear(): Promise<void> {
    await (await db()).clear("history");
  },
};

export const snapshotRepo = {
  async listByProject(projectId: string): Promise<Snapshot[]> {
    const all = await (await db()).getAllFromIndex("snapshots", "projectId", projectId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  async add(snapshot: Snapshot): Promise<void> {
    await (await db()).put("snapshots", snapshot);
  },
  async delete(id: string): Promise<void> {
    await (await db()).delete("snapshots", id);
  },
};
