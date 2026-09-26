import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  buildTree,
  expandCommand,
  getLanguage,
  isSafeRelativePath,
  monacoLanguageForPath,
  parseDiagnostics,
  rebase,
  validateExecutionRequest,
  validateName,
} from "./index.js";

describe("language registry", () => {
  it("has unique ids and a template containing the entry file", () => {
    const ids = LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lang of LANGUAGES) {
      expect(lang.template.some((f) => f.path === lang.entryFile)).toBe(true);
      expect(lang.runtime.image).toMatch(/:/);
    }
  });

  it("marks the P0 languages stable", () => {
    for (const id of ["java", "python", "cpp"]) expect(getLanguage(id)?.supportLevel).toBe("stable");
  });

  it("maps paths to Monaco languages", () => {
    expect(monacoLanguageForPath("src/Main.java")).toBe("java");
    expect(monacoLanguageForPath("a.py")).toBe("python");
    expect(monacoLanguageForPath("notes.txt")).toBe("plaintext");
  });
});

describe("expandCommand", () => {
  const files = [
    { path: "Main.java", content: "" },
    { path: "util/Helper.java", content: "" },
    { path: "README.md", content: "" },
  ];

  it("expands sources filtered by extension", () => {
    const java = getLanguage("java")!;
    expect(expandCommand(java.compiler!.command, { entry: "Main.java", files, sourceExtensions: [".java"] })).toEqual([
      "javac", "-g", "-d", "out", "Main.java", "util/Helper.java",
    ]);
  });

  it("derives a JVM class name from a nested entry", () => {
    expect(expandCommand(["java", "{entryClass}"], { entry: "com/app/Main.java", files })).toEqual(["java", "com.app.Main"]);
  });
});

describe("path safety", () => {
  it.each(["../etc/passwd", "/abs", "a/../b", ".env", "a\\b", "", "a//b", "a b"])("rejects %j", (p) => {
    expect(isSafeRelativePath(p)).toBe(false);
  });
  it.each(["Main.java", "src/app/main.py", "my-file_2.cpp"])("accepts %j", (p) => {
    expect(isSafeRelativePath(p)).toBe(true);
  });
  it("validates user-typed names", () => {
    expect(validateName("ok.py")).toBeNull();
    expect(validateName("a/b")).not.toBeNull();
    expect(validateName("   ")).not.toBeNull();
  });
});

describe("validateExecutionRequest", () => {
  const base = { language: "python", files: [{ path: "main.py", content: "print(1)" }], entry: "main.py" };

  it("accepts a valid request", () => {
    expect(validateExecutionRequest(base).ok).toBe(true);
  });
  it("rejects unknown languages, unsafe paths and missing entry", () => {
    expect(validateExecutionRequest({ ...base, language: "cobol" }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, files: [{ path: "../x.py", content: "" }] }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, entry: "other.py" }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, files: [base.files[0], base.files[0]] }).ok).toBe(false);
  });
  it("rejects oversized files", () => {
    const big = "x".repeat(300 * 1024);
    expect(validateExecutionRequest({ ...base, files: [{ path: "main.py", content: big }] }).ok).toBe(false);
  });
});

describe("parseDiagnostics", () => {
  it("parses javac errors with caret column", () => {
    const out = `Main.java:3: error: ';' expected
        int value = 10
                      ^
1 error`;
    expect(parseDiagnostics("java", out, ["Main.java"])).toEqual([
      { file: "Main.java", line: 3, column: 23, severity: "error", message: "';' expected", source: "compiler" },
    ]);
  });

  it("resolves javac basenames to nested project files", () => {
    const d = parseDiagnostics("java", "Helper.java:2: error: cannot find symbol", ["Main.java", "util/Helper.java"]);
    expect(d[0]?.file).toBe("util/Helper.java");
  });

  it("parses JVM runtime stack traces", () => {
    const out = `Exception in thread "main" java.lang.ArithmeticException: / by zero
\tat Main.main(Main.java:5)`;
    expect(parseDiagnostics("java", out, ["Main.java"])[0]).toMatchObject({ file: "Main.java", line: 5, source: "runtime" });
  });

  it("parses gcc errors and warnings", () => {
    const out = `main.cpp: In function 'int main()':
main.cpp:4:5: error: expected ';' before 'return'
main.cpp:2:9: warning: unused variable 'x' [-Wunused-variable]`;
    const d = parseDiagnostics("cpp", out, ["main.cpp"]);
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ line: 4, column: 5, severity: "error" });
    expect(d[1]).toMatchObject({ severity: "warning" });
  });

  it("parses python tracebacks using the innermost project frame", () => {
    const out = `Traceback (most recent call last):
  File "/workspace/main.py", line 5, in <module>
    helper()
  File "/workspace/lib/util.py", line 2, in helper
    return 1 / 0
ZeroDivisionError: division by zero`;
    expect(parseDiagnostics("python", out, ["main.py", "lib/util.py"])).toEqual([
      { file: "lib/util.py", line: 2, severity: "error", message: "ZeroDivisionError: division by zero", source: "runtime" },
    ]);
  });

  it("parses node stack frames", () => {
    const out = `/workspace/main.js:2
  foo();
  ^

ReferenceError: foo is not defined
    at Object.<anonymous> (/workspace/main.js:2:3)
    at node:internal/main:1:1`;
    expect(parseDiagnostics("javascript", out, ["main.js"])[0]).toMatchObject({ file: "main.js", line: 2, column: 3 });
  });

  it("ignores frames outside the project", () => {
    expect(parseDiagnostics("cpp", "/usr/include/x.h:1:1: error: boom", ["main.cpp"])).toEqual([]);
  });
});

describe("tree", () => {
  it("builds folders-first sorted trees including empty folders", () => {
    const tree = buildTree([{ path: "b.py", content: "" }, { path: "src/a.py", content: "" }], ["empty"]);
    expect(tree.map((n) => n.path)).toEqual(["empty", "src", "b.py"]);
    expect(tree[1]?.children.map((n) => n.path)).toEqual(["src/a.py"]);
  });
  it("rebases paths on rename", () => {
    expect(rebase("src/a/b.py", "src/a", "lib")).toBe("lib/b.py");
    expect(rebase("src/ab/b.py", "src/a", "lib")).toBe("src/ab/b.py");
  });
});
