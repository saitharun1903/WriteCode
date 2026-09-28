import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  buildTree,
  expandCommand,
  findEntryPoints,
  getLanguage,
  isSafeRelativePath,
  monacoLanguageForPath,
  parseDiagnostics,
  rebase,
  validateExecutionRequest,
  validateName,
  parseDebugCommand,
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
    const argv = expandCommand(java.compiler!.command, { entry: "Main.java", files, sourceExtensions: [".java"] });
    expect(argv[0]).toBe("javac");
    expect(argv.slice(-2)).toEqual(["Main.java", "util/Helper.java"]);
    expect(argv).not.toContain("README.md");
  });

  it("derives the JVM class name from the package declaration, not the folder", () => {
    const pkg = [{ path: "src/com/app/Main.java", content: "package com.app;\n\npublic class Main {\n  public static void main(String[] args) {}\n}\n" }];
    expect(expandCommand(["java", "{entryClass}"], { entry: "src/com/app/Main.java", files: pkg })).toEqual(["java", "com.app.Main"]);
    const noPkg = [{ path: "demo/Tool.java", content: "class Tool { public static void main(String... a) {} }" }];
    expect(expandCommand(["java", "{entryClass}"], { entry: "demo/Tool.java", files: noPkg })).toEqual(["java", "Tool"]);
  });
});

describe("entry points", () => {
  it("finds Java main methods with packages, nesting and modifier order", () => {
    const files = [
      {
        path: "src/app/Main.java",
        content: `package app;
// public static void main(String[] args) in a comment
public class Main {
    static String s = "public static void main(String[] args)";
    public static void main(String[] args) { new Runnable() { public void run() {} }; }
    static class Inner {
        static public void main(final String... args) {}
    }
    void main(String[] args) {}
    private static void main(int x) {}
}
interface Tool { static void main(String[] a) {} }
record Point(int x) { public static void main(String a[]) {} }
`,
      },
      { path: "src/app/Plain.java", content: "package app; class Plain { void run() {} }" },
    ];
    expect(findEntryPoints("java", files).map((e) => `${e.mainClass}@${e.line}`)).toEqual(["app.Main@5", "app.Main$Inner@7", "app.Tool@12", "app.Point@13"]);
  });

  it("finds C/C++ main and Python main guards, ignoring comments and strings", () => {
    const c = [
      { path: "util.cpp", content: 'const char* s = "int main(";\nint helper() { return 1; }\n' },
      { path: "main.cpp", content: "// int main() old\n#include <cstdio>\nint main() {\n  return 0;\n}\n" },
    ];
    expect(findEntryPoints("cpp", c)).toEqual([{ file: "main.cpp", line: 3, label: "main.cpp" }]);
    const py = [
      { path: "lib.py", content: 'DOC = """\nif __name__ == "__main__":\n"""\n' },
      { path: "main.py", content: 'def f():\n    pass\n\nif __name__ == "__main__":\n    f()\n' },
    ];
    expect(findEntryPoints("python", py).map((e) => `${e.file}:${e.line}`)).toEqual(["main.py:4"]);
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

describe("debug protocol", () => {
  const base = { language: "java", files: [{ path: "Main.java", content: "" }], entry: "Main.java" };

  it("accepts debug mode with breakpoints for Java", () => {
    const r = validateExecutionRequest({ ...base, mode: "debug", breakpoints: { "Main.java": [3, 3, 1] } });
    expect(r.ok && r.value.breakpoints).toEqual({ "Main.java": [1, 3] });
  });

  it("accepts debug mode for Python", () => {
    const r = validateExecutionRequest({ language: "python", files: [{ path: "main.py", content: "" }], entry: "main.py", mode: "debug", breakpoints: { "main.py": [2] } });
    expect(r.ok && r.value.mode).toBe("debug");
  });

  it("accepts test mode with inputs and rejects stray or oversized tests", () => {
    const r = validateExecutionRequest({ ...base, mode: "test", tests: ["1 2", ""] });
    expect(r.ok && r.value.tests).toEqual(["1 2", ""]);
    expect(validateExecutionRequest({ ...base, mode: "test", tests: [] }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, mode: "test", tests: [1] }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, mode: "test", tests: Array(13).fill("") }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, mode: "test", tests: ["x"], stdin: "y" }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, tests: ["x"] }).ok).toBe(false);
  });

  it("rejects debug mode for languages without a debugger and bad breakpoints", () => {
    expect(validateExecutionRequest({ language: "cpp", files: [{ path: "main.cpp", content: "" }], entry: "main.cpp", mode: "debug" }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, mode: "debug", breakpoints: { "Other.java": [1] } }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, mode: "debug", breakpoints: { "Main.java": [0] } }).ok).toBe(false);
    expect(validateExecutionRequest({ ...base, mode: "fly" }).ok).toBe(false);
  });

  it("parses only well-formed debug commands", () => {
    expect(parseDebugCommand({ cmd: "stepOver", extra: 1 })).toEqual({ cmd: "stepOver" });
    expect(parseDebugCommand({ cmd: "variables", ref: 4 })).toEqual({ cmd: "variables", ref: 4 });
    expect(parseDebugCommand({ cmd: "variables", ref: -1 })).toBeNull();
    expect(parseDebugCommand({ cmd: "evaluate", expression: "x * 2", frame: 0 })).toEqual({ cmd: "evaluate", expression: "x * 2", frame: 0 });
    expect(parseDebugCommand({ cmd: "evaluate", expression: " ", frame: 0 })).toBeNull();
    expect(parseDebugCommand({ cmd: "launch" })).toBeNull();
  });
});
