import { describe, expect, it } from "vitest";
import {
  SQL_STATE_FILE,
  SQL_STATE_MARK,
  splitSqlOutput,
  sqlStateFile,
  LANGUAGES,
  anyFileIsRunnable,
  buildTree,
  canRunFile,
  compilePlans,
  expandCommand,
  findEntryPoints,
  classFilesUsed,
  modulesUsed,
  runTarget,
  getLanguage,
  isSafeRelativePath,
  monacoLanguageForPath,
  parseDiagnostics,
  rebase,
  validateExecutionRequest,
  validateName,
  parseDebugCommand,
  requireLanguage,
} from "./index.js";

describe("language registry", () => {
  it("has unique ids and a template containing the entry file", () => {
    const ids = LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const lang of LANGUAGES) {
      expect(lang.template.some((f) => f.path === lang.entryFile)).toBe(true);
      // A language that runs in the browser has no sandbox image.
      if (!lang.preview) expect(lang.runtime.image).toMatch(/:/);
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

  it("debugs and visualizes the languages that say they can, and no others; rejects bad breakpoints", () => {
    for (const lang of LANGUAGES) {
      const entry = lang.entryFile;
      const request = (mode: string) => validateExecutionRequest({ language: lang.id, files: [{ path: entry, content: "" }], entry, mode }).ok;
      expect(request("debug"), `${lang.id} debug`).toBe(!!lang.debugger && !lang.preview);
      expect(request("visualize"), `${lang.id} visualize`).toBe(!!lang.visualizer && !lang.preview);
      // A page that runs in the browser is never sent to a sandbox.
      expect(request("run"), `${lang.id} run`).toBe(!lang.preview);
    }
    for (const id of ["java", "python", "c", "cpp", "javascript", "typescript", "kotlin"]) expect(getLanguage(id)?.debugger && getLanguage(id)?.visualizer, id).toBeTruthy();
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

describe("what Run builds and starts", () => {
  const javaMain = (name: string, body = "") => `public class ${name} {\n  public static void main(String[] args) {${body}}\n}\n`;

  it("runs the file in the editor when it is a program, in every language", () => {
    const java = { language: "java", entryFile: "Main.java", files: [{ path: "Main.java", content: javaMain("Main") }, { path: "Other.java", content: javaMain("Other") }, { path: "Helper.java", content: "class Helper {}" }] };
    expect(runTarget(java, "Other.java")).toEqual({ entry: "Other.java" });
    // A class with no main method is not a program: the entry file runs.
    expect(runTarget(java, "Helper.java")).toEqual({ entry: "Main.java" });
    expect(runTarget(java, null)).toEqual({ entry: "Main.java" });

    const c = { language: "c", entryFile: "main.c", files: [{ path: "main.c", content: "int main(void) { return 0; }" }, { path: "b.c", content: "int main(void) { return 1; }" }, { path: "b.h", content: "" }] };
    expect(runTarget(c, "b.c")).toEqual({ entry: "b.c" });
    expect(runTarget(c, "b.h")).toEqual({ entry: "main.c" });

    for (const [language, ext] of [["python", "py"], ["javascript", "js"], ["typescript", "ts"]] as const) {
      const p = { language, entryFile: `main.${ext}`, files: [{ path: `main.${ext}`, content: "" }, { path: `two.${ext}`, content: "" }, { path: "data.txt", content: "" }] };
      expect(runTarget(p, `two.${ext}`)).toEqual({ entry: `two.${ext}` });
      expect(runTarget(p, "data.txt")).toEqual({ entry: `main.${ext}` });
    }
  });

  it("a module the entry program loads runs that program; a program of its own runs itself", () => {
    const py = {
      language: "python",
      entryFile: "main.py",
      files: [
        { path: "main.py", content: "import sys, shapes\nfrom tools.maths import twice\nprint(twice(2))\n" },
        { path: "shapes.py", content: "from tools import paint\ndef area(): return 1\n" },
        { path: "tools/maths.py", content: "def twice(n): return n * 2\n" },
        { path: "tools/paint.py", content: "def red(): return 'red'\n" },
        { path: "tools/__init__.py", content: "" },
        { path: "sum.py", content: "print(sum([1, 2]))\n" },
        { path: "guarded.py", content: "def f(): return 1\n\nif __name__ == '__main__':\n    print(f())\n" },
      ],
    };
    expect(modulesUsed("python", "main.py", py.files)).toEqual(["shapes.py", "tools/__init__.py", "tools/maths.py"]);
    expect(runTarget(py, "shapes.py")).toEqual({ entry: "main.py" });
    expect(runTarget(py, "tools/maths.py")).toEqual({ entry: "main.py" });
    // Not loaded by main.py (the word "sum" in its code is not an import): a program of its own.
    expect(runTarget(py, "sum.py")).toEqual({ entry: "sum.py" });
    expect(runTarget(py, "tools/paint.py")).toEqual({ entry: "tools/paint.py" });
    // Loaded or not, a file with a start of its own runs itself.
    expect(runTarget({ ...py, files: [{ path: "main.py", content: "import guarded\n" }, ...py.files.slice(1)] }, "guarded.py")).toEqual({ entry: "guarded.py" });

    for (const [language, ext, load] of [
      ["javascript", "js", 'const { Stack } = require("./lib/stack");\nimport("./lazy.js");\n'],
      ["typescript", "ts", 'import { Stack } from "./lib/stack.ts";\nconst lazy = await import("./lazy.ts");\n'],
    ] as const) {
      const p = {
        language,
        entryFile: `main.${ext}`,
        files: [
          { path: `main.${ext}`, content: load },
          { path: `lib/stack.${ext}`, content: language === "javascript" ? 'const node = require("./node");\n' : 'import { Node } from "./node";\n' },
          { path: `lib/node.${ext}`, content: "" },
          { path: `lazy.${ext}`, content: "" },
          { path: `other.${ext}`, content: 'console.log("stack");\n' },
        ],
      };
      expect(modulesUsed(language, p.entryFile, p.files), language).toEqual([`lazy.${ext}`, `lib/node.${ext}`, `lib/stack.${ext}`]);
      expect(runTarget(p, `lib/node.${ext}`), language).toEqual({ entry: `main.${ext}` });
      expect(runTarget(p, `other.${ext}`), language).toEqual({ entry: `other.${ext}` });
    }
  });

  it("asks when the program cannot be told", () => {
    const p = { language: "java", entryFile: "Gone.java", files: [{ path: "A.java", content: javaMain("A") }, { path: "B.java", content: javaMain("B") }, { path: "notes.txt", content: "" }] };
    expect(runTarget(p, "notes.txt")).toEqual({ entry: "Gone.java", choices: ["A.java", "B.java"] });
    expect(runTarget({ ...p, files: p.files.slice(1) }, null)).toEqual({ entry: "B.java" });
  });

  it("every language says how it is built, where programs start and how errors read", () => {
    for (const lang of LANGUAGES.filter((l) => !l.preview)) {
      expect(lang.diagnostics.length, lang.id).toBeGreaterThan(0);
      expect(anyFileIsRunnable(lang.id), lang.id).toBe(!lang.compiler);
      // A compiled language has to say where a program starts, or Run could not tell programs apart.
      if (lang.compiler) expect(lang.entryPoints, lang.id).toBeDefined();
      expect(canRunFile(lang.id, lang.template.find((f) => f.path === lang.entryFile)!), lang.id).toBe(true);
    }
  });

  it("Java: gives the compiler the file being run and the files it uses", () => {
    const java = getLanguage("java")!;
    const files = [
      { path: "Main.java", content: javaMain("Main", ' new Node(); Tools.twice(2); /* Broken */ String s = "Broken"; ') },
      { path: "util/Tools.java", content: "public class Tools { static int twice(int n) { return Maths.twice(n); } }" },
      { path: "util/Maths.java", content: "public class Maths { static int twice(int n) { return n * 2; } }" },
      { path: "lists/LinkedList.java", content: "public class LinkedList {}\nclass Node {}\n" },
      { path: "Broken.java", content: "public class Broken {" },
    ];
    const plans = compilePlans(java, { entry: "Main.java", files });
    // A name in a comment or a string is not a use: Broken.java stays out.
    expect(plans.map((p) => p.sources)).toEqual([["Main.java", "lists/LinkedList.java", "util/Maths.java", "util/Tools.java"]]);
    const argv = plans[0]!.argv;
    expect(argv[argv.indexOf("-sourcepath") + 1]).toBe(".:lists:util");
    expect(argv.slice(-4)).toEqual(plans[0]!.sources);
    expect(classFilesUsed("java", "Broken.java", files)).toEqual([]);
    expect(classFilesUsed("java", "util/Tools.java", files)).toEqual(["util/Maths.java"]);
    // One file: one build.
    expect(compilePlans(java, { entry: "Main.java", files: files.slice(0, 1) })).toHaveLength(1);
  });

  it("C and C++: leaves out the other programs, then the helpers too", () => {
    const cpp = getLanguage("cpp")!;
    const files = [
      { path: "main.cpp", content: "int main() {}" },
      { path: "other.cpp", content: "int main() {}" },
      { path: "util.cpp", content: "int twice(int n) { return n * 2; }" },
      { path: "util.h", content: "" },
    ];
    expect(compilePlans(cpp, { entry: "main.cpp", files }).map((p) => p.sources)).toEqual([["main.cpp", "util.cpp"], ["main.cpp"]]);
    expect(compilePlans(cpp, { entry: "other.cpp", files }).map((p) => p.sources)).toEqual([["other.cpp", "util.cpp"], ["other.cpp"]]);
    expect(compilePlans(cpp, { entry: "main.cpp", files: files.slice(0, 2) }).map((p) => p.sources)).toEqual([["main.cpp"]]);
    // The debugger's build follows the same plan.
    expect(compilePlans(cpp, { entry: "main.cpp", files }, cpp.debugger!.compiler)[0]!.argv).toEqual(["g++", "-std=c++20", "-O0", "-g3", "-Wall", "-o", "out/main", "main.cpp", "util.cpp"]);
    expect(compilePlans(getLanguage("python")!, { entry: "main.py", files: [] })).toEqual([]);
  });
});

describe("errors of the languages added later", () => {
  const first = (language: string, text: string, files: string[]) => parseDiagnostics(language, text, files)[0];

  it("Go: compiler errors and the place of a panic", () => {
    expect(parseDiagnostics("go", "# command-line-arguments\n./main.go:6:2: declared and not used: x\n./main.go:7:14: undefined: y\n", ["main.go"])).toEqual([
      { file: "main.go", line: 6, column: 2, severity: "error", message: "declared and not used: x", source: "compiler" },
      { file: "main.go", line: 7, column: 14, severity: "error", message: "undefined: y", source: "compiler" },
    ]);
    expect(first("go", "panic: runtime error: index out of range [3] with length 1\n\ngoroutine 1 [running]:\nmain.main()\n\t/workspace/main.go:8 +0x17\n", ["main.go"])).toMatchObject({ file: "main.go", line: 8, source: "runtime", message: "panic: runtime error: index out of range [3] with length 1" });
  });

  it("Rust: an error with its arrow line, and a panic", () => {
    expect(first("rust", 'error[E0308]: mismatched types\n --> main.rs:1:26\n  |\n1 | fn main() { let x: i32 = "a"; }\n', ["main.rs"])).toEqual({ file: "main.rs", line: 1, column: 26, severity: "error", message: "mismatched types", source: "compiler" });
    expect(first("rust", "\nthread 'main' panicked at main.rs:1:46:\nindex out of bounds: the len is 1 but the index is 3\nnote: run with `RUST_BACKTRACE=1`\n", ["main.rs"])).toMatchObject({ line: 1, column: 46, source: "runtime", message: "index out of bounds: the len is 1 but the index is 3" });
  });

  it("C#: the compiler's line and column, and the line an exception was thrown on", () => {
    expect(first("csharp", "Program.cs(5,13): error CS0029: Cannot implicitly convert type 'string' to 'int'\n", ["Program.cs"])).toEqual({ file: "Program.cs", line: 5, column: 13, severity: "error", message: "Cannot implicitly convert type 'string' to 'int' (CS0029)", source: "compiler" });
    expect(first("csharp", "Unhandled exception. System.IndexOutOfRangeException: Index was outside the bounds of the array.\n   at Program.Main(String[] args) in /workspace/Program.cs:line 8\n", ["Program.cs"])).toMatchObject({ file: "Program.cs", line: 8, source: "runtime", message: "System.IndexOutOfRangeException: Index was outside the bounds of the array." });
  });

  it("SQL: what a run prints is told apart from the database it leaves", () => {
    const report = { v: 1, log: [{ line: 1, sql: "SELECT 1;", message: "1 row returned", ok: true, ms: 0.1 }], tables: [{ name: "t", kind: "table", columns: [{ name: "id", type: "INTEGER", pk: true }], rows: 2 }], data: "eJw=", names: ["school"], current: "school" };
    const out = splitSqlOutput(`a\n-\n1\n(1 row)\n\n${SQL_STATE_MARK}${JSON.stringify(report)}\n`);
    expect(out.text).toBe("a\n-\n1\n(1 row)\n\n");
    expect(out.report).toEqual({ log: report.log, database: { data: "eJw=", names: ["school"], current: "school", tables: report.tables } });
    // The next run is sent what the last one left.
    expect(JSON.parse(sqlStateFile(out.report!.database))).toEqual({ data: "eJw=", names: ["school"], current: "school" });
    expect(JSON.parse(sqlStateFile(undefined))).toEqual({ data: "", names: [], current: null });
    // Output with nothing after it, a report that was cut, and one whose database could not be kept.
    expect(splitSqlOutput("x\n")).toEqual({ text: "x\n", report: null });
    expect(splitSqlOutput(`x\n${SQL_STATE_MARK}{"v":1,"log":[`)).toEqual({ text: "x\n", report: null });
    expect(splitSqlOutput(`x\n${SQL_STATE_MARK}${JSON.stringify({ log: [], tables: [], tooLarge: true, names: [], current: null })}\n`).report).toEqual({ log: [], tooLarge: true });
    // What is not a database is not taken for one.
    expect(splitSqlOutput(`${SQL_STATE_MARK}${JSON.stringify({ log: [], tables: [{ name: 1 }], data: "", names: [] })}`).report).toEqual({ log: [] });
    expect(getLanguage("sql")?.database?.file).toBe(SQL_STATE_FILE);
  });

  it("PHP, Ruby, Bash and SQL", () => {
    expect(first("php", '\nParse error: syntax error, unexpected token "echo" in /workspace/main.php on line 3\n', ["main.php"])).toMatchObject({ file: "main.php", line: 3, source: "compiler" });
    expect(first("php", "\nFatal error: Uncaught Exception: boom in /workspace/main.php:2\nStack trace:\n#0 /workspace/main.php(3): f()\n", ["main.php"])).toMatchObject({ line: 2, source: "runtime", message: "Uncaught Exception: boom" });
    expect(first("ruby", "main.rb:2:in 'Object#f': boom (RuntimeError)\n\tfrom main.rb:4:in '<main>'\n", ["main.rb"])).toMatchObject({ line: 2, source: "runtime", message: "boom (RuntimeError)" });
    expect(first("ruby", "main.rb: --> main.rb\n\nmain.rb:2: syntax error found (SyntaxError)\n", ["main.rb"])).toMatchObject({ line: 2, source: "compiler" });
    expect(parseDiagnostics("bash", "main.sh: line 2: foo: command not found\nmain.sh: line 5: syntax error near unexpected token `then'\nmain.sh: line 5: `if then'\n", ["main.sh"]).map((d) => [d.line, d.message])).toEqual([
      [2, "foo: command not found"],
      [5, "syntax error near unexpected token `then'"],
    ]);
    expect(first("sql", "main.sql:7: error: no such table: student\n", ["main.sql"])).toMatchObject({ line: 7, message: "no such table: student" });
  });
});

describe("where a program starts, in the languages added later", () => {
  const starts = (language: string, path: string, content: string) => findEntryPoints(language, [{ path, content }]).map((e) => e.line);

  it("finds the main function each language declares, not one in a comment", () => {
    expect(starts("go", "main.go", "package main\n\n// func main() {}\nfunc main() {\n}\n")).toEqual([4]);
    expect(starts("go", "util.go", "package main\n\nfunc twice(x int) int { return x * 2 }\n")).toEqual([]);
    expect(starts("rust", "main.rs", "mod util;\n\nfn main() {\n}\n")).toEqual([3]);
    expect(starts("csharp", "Program.cs", "using System;\n\nclass Program\n{\n    static async Task Main(string[] args)\n    {\n    }\n}\n")).toEqual([5]);
    expect(starts("csharp", "Util.cs", "static class Util { public static int Twice(int x) => x * 2; }\n")).toEqual([]);
  });

  it("Kotlin: a top-level main, and the class the JVM starts for its file", () => {
    expect(starts("kotlin", "Main.kt", "// fun main() {}\nfun main() {\n}\n")).toEqual([2]);
    expect(starts("kotlin", "Util.kt", "fun twice(x: Int) = x * 2\n")).toEqual([]);
    const run = requireLanguage("kotlin").runtime.command;
    expect(expandCommand(run, { entry: "Main.kt", files: [{ path: "Main.kt", content: "fun main() {}\n" }] }).at(-1)).toBe("MainKt");
    expect(expandCommand(run, { entry: "app/hello-world.kt", files: [{ path: "app/hello-world.kt", content: "package app.demo\n\nfun main() {}\n" }] }).at(-1)).toBe("app.demo.Hello_worldKt");
    // Its errors read like gcc's, and its exceptions like the JVM's.
    expect(parseDiagnostics("kotlin", "Main.kt:2:18: error: initializer type mismatch\n", ["Main.kt"])[0]).toMatchObject({ line: 2, column: 18, source: "compiler" });
    expect(parseDiagnostics("kotlin", 'Exception in thread "main" java.lang.IndexOutOfBoundsException: Index 3\n\tat MainKt.main(Main.kt:4)\n\tat MainKt.main(Main.kt)\n', ["Main.kt"])[0]).toMatchObject({ line: 4, source: "runtime" });
  });

  it("a compiler given only the entry file is asked once", () => {
    const files = [
      { path: "main.rs", content: "mod util;\nfn main() {}\n" },
      { path: "util.rs", content: "pub fn twice(x: i32) -> i32 { x * 2 }\n" },
    ];
    const plans = compilePlans(requireLanguage("rust"), { entry: "main.rs", files });
    expect(plans.map((p) => p.argv.at(-1))).toEqual(["main.rs"]);
    // Go and C# link every file that is not a program of its own.
    const go = compilePlans(requireLanguage("go"), { entry: "a.go", files: [{ path: "a.go", content: "package main\nfunc main() {}\n" }, { path: "b.go", content: "package main\nfunc main() {}\n" }, { path: "c.go", content: "package main\nfunc f() {}\n" }] });
    expect(go[0]!.sources).toEqual(["a.go", "c.go"]);
  });

  it("a language that runs in the browser names no sandbox image", () => {
    const html = requireLanguage("html");
    expect(html.preview).toBe("browser");
    expect(html.runtime.image).toBe("");
  });
});
