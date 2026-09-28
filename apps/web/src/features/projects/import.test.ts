import { describe, expect, it } from "vitest";
import { REQUEST_BOUNDS, type Project } from "@cw/shared";
import { applyImport, planImport, safePath } from "./import";

const text = (s: string) => new TextEncoder().encode(s);
const project = (files: string[] = ["Main.java"]): Project => ({
  id: "p",
  name: "P",
  language: "java",
  entryFile: "Main.java",
  files: files.map((path) => ({ path, content: "old" })),
  folders: [],
  stdin: "",
  createdAt: 0,
  updatedAt: 0,
});

describe("importing files", () => {
  it("adds text files, keeps folders, marks replacements and renames unusable names", () => {
    const plan = planImport(project(), [
      { path: "Main.java", bytes: text("class Main {}\r\n") },
      { path: "src/util/Helper.java", bytes: text("class Helper {}") },
      { path: "My Notes.txt", bytes: text("﻿hello") },
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.files).toEqual([
      { path: "Main.java", content: "class Main {}\n", replaces: true },
      { path: "My_Notes.txt", content: "hello", replaces: false, renamedFrom: "My Notes.txt" },
      { path: "src/util/Helper.java", content: "class Helper {}", replaces: false },
    ]);
    const next = applyImport(project(), plan.files);
    expect(next.files.map((f) => [f.path, f.content])).toEqual([
      ["Main.java", "class Main {}\n"],
      ["My_Notes.txt", "hello"],
      ["src/util/Helper.java", "class Helper {}"],
    ]);
  });

  it("skips binaries, build and hidden folders, oversized files, and files beyond the project limit, saying why", () => {
    const plan = planImport(project(), [
      { path: "Main.class", bytes: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]) },
      { path: "data.bin", bytes: new Uint8Array([1, 0, 2]) },
      { path: "target/App.java", bytes: text("x") },
      { path: ".git/config", bytes: text("x") },
      { path: "big.txt", bytes: new Uint8Array(REQUEST_BOUNDS.maxFileBytes + 1).fill(65) },
    ]);
    expect(plan.files).toEqual([]);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]))).toEqual({
      "Main.class": "not a text file",
      "data.bin": "not a text file",
      "target/App.java": "build or tool folder",
      ".git/config": "hidden file",
      "big.txt": `larger than ${REQUEST_BOUNDS.maxFileBytes / 1024} KB`,
    });
    const full = project(Array.from({ length: REQUEST_BOUNDS.maxFiles }, (_, i) => `F${i}.java`));
    const over = planImport(full, [{ path: "Extra.java", bytes: text("x") }, { path: "F1.java", bytes: text("new") }]);
    expect(over.files.map((f) => f.path)).toEqual(["F1.java"]);
    expect(over.skipped[0]!.reason).toContain(`up to ${REQUEST_BOUNDS.maxFiles} files`);
  });

  it("makes names the sandbox accepts", () => {
    expect(safePath("My Project\\src\\Main (1).java")).toBe("My_Project/src/Main_1_.java");
    expect(safePath("./a//b.py")).toBe("a/b.py");
  });
});
