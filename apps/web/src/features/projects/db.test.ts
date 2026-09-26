import { beforeEach, describe, expect, it } from "vitest";
import type { HistoryEntry } from "@cw/shared";
import { historyRepo, projectRepo, resetDbConnection, snapshotRepo } from "./db";
import { createProject } from "./operations";

function entry(id: string, projectId: string, createdAt: number): HistoryEntry {
  return {
    id,
    projectId,
    projectName: "P",
    language: "python",
    entryFile: "main.py",
    files: [],
    stdin: "",
    createdAt,
    result: {
      id,
      status: "SUCCESS",
      language: "python",
      stdout: "",
      stderr: "",
      compileOutput: "",
      runtimeVersion: "3.13",
      createdAt: new Date(createdAt).toISOString(),
    },
  };
}

beforeEach(async () => {
  // Fresh database per test.
  await resetDbConnection();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("code-workspace");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

describe("IndexedDB repositories", () => {
  it("round-trips projects and lists newest first", async () => {
    const a = { ...createProject("a", "A", "java"), updatedAt: 1 };
    const b = { ...createProject("b", "B", "python"), updatedAt: 2 };
    await projectRepo.put(a);
    await projectRepo.put(b);
    expect((await projectRepo.list()).map((p) => p.id)).toEqual(["b", "a"]);
    expect((await projectRepo.get("a"))?.files[0]?.path).toBe("Main.java");
  });

  it("cascades history and snapshots on project delete", async () => {
    await projectRepo.put(createProject("a", "A", "java"));
    await projectRepo.put(createProject("b", "B", "java"));
    await historyRepo.add(entry("h1", "a", 1));
    await historyRepo.add(entry("h2", "b", 2));
    await snapshotRepo.add({ id: "s1", projectId: "a", label: "v1", files: [], createdAt: 1 });
    await projectRepo.delete("a");
    expect(await projectRepo.get("a")).toBeUndefined();
    expect((await historyRepo.list()).map((h) => h.id)).toEqual(["h2"]);
    expect(await snapshotRepo.listByProject("a")).toEqual([]);
  });

  it("lists history newest first with a limit", async () => {
    for (let i = 0; i < 5; i++) await historyRepo.add(entry(`h${i}`, "a", i));
    expect((await historyRepo.list(3)).map((h) => h.id)).toEqual(["h4", "h3", "h2"]);
  });
});
