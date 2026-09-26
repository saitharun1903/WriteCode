import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { HistoryEntry, Project, ProjectSummary, Snapshot } from "@cw/shared";
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
  /** Newest first. */
  async list(limit = 200): Promise<HistoryEntry[]> {
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
