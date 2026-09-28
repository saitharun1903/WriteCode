import { describe, expect, it } from "vitest";
import * as ops from "./operations";

const base = () => ops.createProject("p1", "Demo", "java", 1000);

describe("project operations", () => {
  it("creates a project from the language template", () => {
    const p = base();
    expect(p.files.map((f) => f.path)).toEqual(["Main.java"]);
    expect(p.entryFile).toBe("Main.java");
    expect(p.language).toBe("java");
  });

  it("adds files and folders, rejecting duplicates and bad names", () => {
    let p = base();
    p = ops.addFolder(p, "", "util").project;
    p = ops.addFile(p, "util", "Helper.java", "class Helper {}").project;
    expect(p.files.map((f) => f.path)).toContain("util/Helper.java");
    expect(() => ops.addFile(p, "util", "Helper.java")).toThrow(ops.ProjectOperationError);
    expect(() => ops.addFile(p, "", "../evil")).toThrow(ops.ProjectOperationError);
    expect(() => ops.addFolder(p, "", "util")).toThrow(/already exists/);
  });

  it("does not create a new object when content is unchanged", () => {
    const p = base();
    expect(ops.updateFileContent(p, "Main.java", p.files[0]!.content)).toBe(p);
    expect(ops.updateFileContent(p, "Main.java", "x")).not.toBe(p);
  });

  it("renames folders and rewrites nested paths and the entry file", () => {
    let p = base();
    p = ops.addFile(p, "", "src").project; // a file named "src" must not collide with folder rename below
    p = ops.addFolder(p, "", "app").project;
    p = ops.addFile(p, "app", "Main2.java").project;
    p = { ...p, entryFile: "app/Main2.java" };
    const { project, path } = ops.renamePath(p, "app", "core");
    expect(path).toBe("core");
    expect(project.files.map((f) => f.path)).toContain("core/Main2.java");
    expect(project.folders).toEqual(["core"]);
    expect(project.entryFile).toBe("core/Main2.java");
  });

  it("prevents moving a folder into itself", () => {
    let p = ops.addFolder(base(), "", "a").project;
    p = ops.addFolder(p, "a", "b").project;
    expect(() => ops.movePath(p, "a", "a/b/a")).toThrow(/into itself/);
  });

  it("deletes folders recursively and reassigns the entry file", () => {
    let p = ops.addFolder(base(), "", "lib").project;
    p = ops.addFile(p, "lib", "X.java").project;
    p = { ...p, entryFile: "lib/X.java" };
    const next = ops.deletePath(p, "lib");
    expect(next.files.map((f) => f.path)).toEqual(["Main.java"]);
    expect(next.folders).toEqual([]);
    expect(next.entryFile).toBe("Main.java");
  });

  it("duplicates with a unique name and fresh id", () => {
    const p = base();
    const copy = ops.duplicateProject(p, "p2", ["Demo", "Demo copy"]);
    expect(copy.id).toBe("p2");
    expect(copy.name).toBe("Demo copy 2");
    expect(copy.files).not.toBe(p.files);
  });

  it("suggests unique file names", () => {
    let p = base();
    expect(ops.uniqueName(p, "", "Untitled", ".java")).toBe("Untitled.java");
    p = ops.addFile(p, "", "Untitled.java").project;
    expect(ops.uniqueName(p, "", "Untitled", ".java")).toBe("Untitled2.java");
  });

  it("toggles breakpoints and keeps them sorted and unique", () => {
    let p = base();
    p = ops.toggleBreakpoint(p, "Main.java", 5);
    p = ops.toggleBreakpoint(p, "Main.java", 2);
    expect(ops.breakpointsFor(p, "Main.java")).toEqual([2, 5]);
    p = ops.toggleBreakpoint(p, "Main.java", 5);
    expect(ops.breakpointsFor(p, "Main.java")).toEqual([2]);
    expect(ops.setBreakpoints(p, "Main.java", [2])).toBe(p);
    p = ops.setBreakpoints(p, "Main.java", []);
    expect(p.breakpoints).toEqual({});
  });

  it("moves and drops breakpoints with their files", () => {
    let p = ops.addFolder(base(), "", "lib").project;
    p = ops.addFile(p, "lib", "A.java").project;
    p = ops.toggleBreakpoint(p, "lib/A.java", 3);
    p = ops.toggleBreakpoint(p, "Main.java", 1);
    p = ops.renamePath(p, "lib", "core").project;
    expect(p.breakpoints).toEqual({ "core/A.java": [3], "Main.java": [1] });
    p = ops.deletePath(p, "core");
    expect(p.breakpoints).toEqual({ "Main.java": [1] });
  });
});

describe("recent-work tracking", () => {
  it("treats a project as untouched until it is changed, even after running it", () => {
    const fresh = ops.createProject("p1", "Java project", "java");
    expect(ops.summarize(fresh).untouched).toBe(true);
    expect(ops.summarize({ ...fresh, lastRunAt: Date.now() }).untouched).toBe(true);
    expect(ops.summarize({ ...fresh, stdin: "5" }).untouched).toBe(false);
    const edited = ops.updateFileContent(fresh, "Main.java", fresh.files[0]!.content + "// note\n");
    expect(ops.summarize(edited).untouched).toBe(false);
    expect(ops.summarize({ ...fresh, folders: ["src"] }).untouched).toBe(false);
  });

  it("orders by the latest edit or run", () => {
    expect(ops.lastActivity({ updatedAt: 10, lastRunAt: 50 })).toBe(50);
    expect(ops.lastActivity({ updatedAt: 70 })).toBe(70);
  });
});
