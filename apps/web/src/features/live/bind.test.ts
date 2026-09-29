import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { useWorkspace } from "@/features/projects/store";
import * as ops from "@/features/projects/operations";
import { applyTextDiff, bindProject, filesOf, readProject, readTests, testOrderOf, testsOf, writeProject } from "./bind";

/** Two documents connected directly, as two browsers are through the server. */
function linked() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "b" && Y.applyUpdate(b, u, "a"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "a" && Y.applyUpdate(a, u, "b"));
  return [a, b] as const;
}

const text = (doc: Y.Doc, path = "Main.java") => filesOf(doc).get(path)?.toString();

describe("text diff", () => {
  it("changes only what differs", () => {
    const doc = new Y.Doc();
    const t = doc.getText("t");
    t.insert(0, "int x = 1;");
    const ops: unknown[] = [];
    t.observe((e) => ops.push(e.delta));
    doc.transact(() => applyTextDiff(t, "int x = 42;"));
    expect(t.toString()).toBe("int x = 42;");
    expect(ops).toEqual([[{ retain: 8 }, { delete: 1 }, { insert: "42" }]]);
    doc.transact(() => applyTextDiff(t, "int x = 42;"));
    expect(ops).toHaveLength(1);
  });

  it("never splits a two-unit character", () => {
    const doc = new Y.Doc();
    const t = doc.getText("t");
    t.insert(0, "a😀b");
    applyTextDiff(t, "a😃b");
    expect(t.toString()).toBe("a😃b");
  });

  it("two people typing in the same file at once both keep their changes", () => {
    const [a, b] = linked();
    const ta = a.getText("t");
    ta.insert(0, "class Main {\n}\n");
    const tb = b.getText("t");
    // Both edit before seeing the other's change (applied to a copy, merged afterwards).
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(b));
    applyTextDiff(ta, "public class Main {\n}\n");
    applyTextDiff(offline.getText("t"), "class Main {\n  int x;\n}\n");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(offline));
    expect(ta.toString()).toBe("public class Main {\n  int x;\n}\n");
    expect(tb.toString()).toBe(ta.toString());
  });
});

describe("binding a project to the shared document", () => {
  afterEach(() => useWorkspace.setState({ project: null, sharedId: null, readOnly: false }));

  function setup() {
    const project = ops.createProject("p1", "Demo", "java", 1000);
    useWorkspace.setState({ project, openTabs: ["Main.java"], activeFile: "Main.java", sharedId: "p1" });
    const [mine, theirs] = linked();
    writeProject(mine, project);
    const binding = bindProject(mine, "p1", () => true);
    return { mine, theirs, binding };
  }

  it("edits made here reach the other person", () => {
    const { theirs, binding } = setup();
    expect(readProject(theirs).files.map((f) => f.path)).toEqual(["Main.java"]);
    useWorkspace.getState().updateFile("Main.java", "// changed\n");
    expect(text(theirs)).toBe("// changed\n");
    useWorkspace.getState().createFile("", "Helper.java");
    expect(filesOf(theirs).has("Helper.java")).toBe(true);
    useWorkspace.getState().setStdin("5\n");
    expect(readProject(theirs).stdin).toBe("5\n");
    binding.unbind();
  });

  it("the other person's edits, new files and deletions arrive here", () => {
    const { theirs, binding } = setup();
    filesOf(theirs).get("Main.java")!.insert(0, "// hi\n");
    expect(useWorkspace.getState().project!.files[0]!.content.startsWith("// hi\n")).toBe(true);
    theirs.transact(() => {
      const t = new Y.Text();
      t.insert(0, "class Util {}");
      filesOf(theirs).set("Util.java", t);
    });
    expect(useWorkspace.getState().project!.files.map((f) => f.path)).toEqual(["Main.java", "Util.java"]);
    useWorkspace.getState().openFile("Util.java");
    filesOf(theirs).delete("Util.java");
    const ws = useWorkspace.getState();
    expect(ws.project!.files.map((f) => f.path)).toEqual(["Main.java"]);
    // Its tab closes.
    expect(ws.openTabs).toEqual(["Main.java"]);
    binding.unbind();
  });

  it("undo takes back only your own change, not someone else's", () => {
    const { mine, theirs, binding } = setup();
    useWorkspace.getState().updateFile("Main.java", "// mine\n");
    filesOf(theirs).get("Main.java")!.insert(text(theirs)!.length, "// theirs\n");
    expect(text(mine)).toBe("// mine\n// theirs\n");
    expect(binding.undo("Main.java")).toBe(true);
    expect(useWorkspace.getState().project!.files[0]!.content).not.toContain("// mine");
    expect(useWorkspace.getState().project!.files[0]!.content).toContain("// theirs");
    expect(text(theirs)).not.toContain("// mine");
    binding.unbind();
  });

  it("view-only people's changes are not shared", () => {
    const project = ops.createProject("p1", "Demo", "java", 1000);
    useWorkspace.setState({ project, sharedId: "p1" });
    const [mine, theirs] = linked();
    writeProject(mine, project);
    const binding = bindProject(mine, "p1", () => false);
    useWorkspace.setState({ project: { ...project, files: [{ path: "Main.java", content: "changed" }] } });
    expect(text(theirs)).toBe(project.files[0]!.content);
    binding.unbind();
  });

  it("test cases are shared: added, edited, duplicated in place and deleted", () => {
    const { theirs, binding } = setup();
    useWorkspace.getState().setTests([{ id: "t1", input: "3", expected: "6" }]);
    expect(readTests(theirs)).toEqual([{ id: "t1", input: "3", expected: "6" }]);
    useWorkspace.getState().setTests([
      { id: "t1", input: "4", expected: "8" },
      { id: "t2", input: "5", expected: "10" },
    ]);
    // A duplicate goes right under its original.
    useWorkspace.getState().setTests([
      { id: "t1", input: "4", expected: "8" },
      { id: "t1b", input: "4", expected: "8" },
      { id: "t2", input: "5", expected: "10" },
    ]);
    expect(readTests(theirs).map((t) => t.id)).toEqual(["t1", "t1b", "t2"]);
    // Their edit and deletion arrive here.
    testsOf(theirs).get("t2")!.get("expected")!.insert(2, "0");
    theirs.transact(() => {
      testsOf(theirs).delete("t1b");
      testOrderOf(theirs).delete(1, 1);
    });
    expect(useWorkspace.getState().project!.tests).toEqual([
      { id: "t1", input: "4", expected: "8" },
      { id: "t2", input: "5", expected: "100" },
    ]);
    binding.unbind();
  });
});
