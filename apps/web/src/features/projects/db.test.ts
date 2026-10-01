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

  it("running the same code again updates its entry; changed code adds one", async () => {
    const run = (id: string, content: string, at: number, stdout: string) => ({ ...entry(id, "a", at), files: [{ path: "Main.java", content }], result: { ...entry(id, "a", at).result, stdout } });
    await historyRepo.record(run("h1", "v1", 1, "one"));
    await historyRepo.record(run("h2", "v1", 2, "one again"));
    await historyRepo.record(run("h3", "v2", 3, "two"));
    await historyRepo.record(run("h4", "v1", 4, "one, later"));
    const list = await historyRepo.list();
    expect(list.map((h) => [h.id, h.createdAt, h.runs ?? 1, h.firstRunAt ?? h.createdAt, h.result.stdout])).toEqual([
      ["h1", 4, 3, 1, "one, later"],
      ["h3", 3, 1, 3, "two"],
    ]);
    // The same code in another project is that project's own entry.
    await historyRepo.record({ ...run("h5", "v1", 5, "one"), projectId: "b" });
    expect(await historyRepo.list()).toHaveLength(3);
  });

  it("lists history newest first with a limit", async () => {
    for (let i = 0; i < 5; i++) await historyRepo.add(entry(`h${i}`, "a", i));
    expect((await historyRepo.list(3)).map((h) => h.id)).toEqual(["h4", "h3", "h2"]);
  });
});
