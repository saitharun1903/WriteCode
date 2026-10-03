import { SQL_RUNNER, SQL_STATE_FILE } from "./sql-runner.js";
import type { LanguageDefinition } from "./types.js";

const java: LanguageDefinition = {
  id: "java",
  name: "Java",
  version: "21 (Temurin)",
  extensions: [".java"],
  monacoLanguage: "java",
  supportLevel: "stable",
  entryFile: "Main.java",
  entryPoints: "class-main",
  diagnostics: ["javac", "jvm-trace"],
  template: [
    {
      path: "Main.java",
      content: `public class Main {
    public static void main(String[] args) {
        System.out.println("Hello World");
    }
}
`,
    },
  ],
  compiler: {
    // Serial GC and C1-only JIT keep javac fast and small inside a 1-CPU sandbox.
    command: ["javac", "-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1", "-g", "-encoding", "UTF-8", "-implicit:class", "-sourcepath", "{sourceRoots}", "-d", "out", "{sources}"],
    sourceExtensions: [".java"],
    builds: "classes",
  },
  runtime: {
    image: "eclipse-temurin:21-jdk",
    command: ["java", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xss8m", "-cp", "out", "{entryClass}"],
  },
  debugger: { protocol: "jdwp", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

const python: LanguageDefinition = {
  id: "python",
  name: "Python",
  version: "3.13",
  extensions: [".py"],
  monacoLanguage: "python",
  supportLevel: "stable",
  entryFile: "main.py",
  entryPoints: "main-guard",
  imports: [String.raw`^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b`, String.raw`^[ \t]*import[ \t]+([\w., \t]+)`],
  diagnostics: ["python"],
  template: [
    {
      path: "main.py",
      content: `def main() -> None:
    print("Hello World")


if __name__ == "__main__":
    main()
`,
    },
  ],
  runtime: {
    image: "python:3.13-slim",
    command: ["python3", "-u", "{entry}"],
  },
  debugger: { protocol: "settrace", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

/** gcc:14 with gdb added (deploy/sandbox/gcc-gdb.Dockerfile), for debugging and visualizing C and C++. */
export const GDB_IMAGE = "writecode/gcc-gdb:14";

const cpp: LanguageDefinition = {
  id: "cpp",
  name: "C++",
  version: "GCC 14 (C++20)",
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".h"],
  monacoLanguage: "cpp",
  supportLevel: "stable",
  entryFile: "main.cpp",
  entryPoints: "function-main",
  diagnostics: ["gcc"],
  template: [
    {
      path: "main.cpp",
      content: `#include <iostream>

int main() {
    std::cout << "Hello World" << std::endl;
    return 0;
}
`,
    },
  ],
  compiler: {
    command: ["g++", "-std=c++20", "-O2", "-g", "-Wall", "-o", "out/main", "{sources}"],
    sourceExtensions: [".cpp", ".cc", ".cxx"],
    builds: "program",
  },
  runtime: {
    image: "gcc:14",
    command: ["./out/main"],
  },
  debugger: {
    protocol: "gdb",
    supportLevel: "beta",
    image: GDB_IMAGE,
    compiler: ["g++", "-std=c++20", "-O0", "-g3", "-Wall", "-o", "out/main", "{sources}"],
  },
  visualizer: { supportLevel: "beta" },
};

const c: LanguageDefinition = {
  id: "c",
  name: "C",
  version: "GCC 14 (C17)",
  extensions: [".c", ".h"],
  monacoLanguage: "c",
  supportLevel: "beta",
  entryFile: "main.c",
  entryPoints: "function-main",
  diagnostics: ["gcc"],
  template: [
    {
      path: "main.c",
      content: `#include <stdio.h>

int main(void) {
    printf("Hello World\\n");
    return 0;
}
`,
    },
  ],
  compiler: {
    command: ["gcc", "-std=c17", "-O2", "-g", "-Wall", "-o", "out/main", "{sources}", "-lm"],
    sourceExtensions: [".c"],
    builds: "program",
  },
  runtime: {
    image: "gcc:14",
    command: ["./out/main"],
  },
  debugger: {
    protocol: "gdb",
    supportLevel: "beta",
    image: GDB_IMAGE,
    compiler: ["gcc", "-std=c17", "-O0", "-g3", "-Wall", "-o", "out/main", "{sources}", "-lm"],
  },
  visualizer: { supportLevel: "beta" },
};

/**
 * Makes Node treat the typed-input pipe like a terminal: once the program stops
 * reading (rl.close(), process.stdin.pause()), stdin no longer keeps it alive,
 * so it exits instead of waiting for the input to end; reading again (resume)
 * keeps it alive as before. A program still listening for lines waits for the
 * end of input, as it would in a terminal. Loaded before the program with
 * --import, as a data: URL, so the sandbox needs no extra file.
 */
const STDIN_LIKE_A_TERMINAL = [
  'const d = Object.getOwnPropertyDescriptor(process, "stdin");',
  "if (d && d.get) {",
  "  let s;",
  '  Object.defineProperty(process, "stdin", { configurable: true, enumerable: d.enumerable, get() {',
  "    if (!s) {",
  "      s = d.get.call(process);",
  '      if (!s.isTTY && typeof s.unref === "function") {',
  '        s.on("pause", () => s.unref());',
  '        s.on("resume", () => s.ref());',
  "      }",
  "    }",
  "    return s;",
  "  } });",
  "}",
].join("\n");
export const NODE_STDIN_FLAG = `--import=data:text/javascript,${encodeURIComponent(STDIN_LIKE_A_TERMINAL)}`;

const javascript: LanguageDefinition = {
  id: "javascript",
  name: "JavaScript",
  version: "Node.js 22",
  extensions: [".js", ".mjs", ".cjs"],
  monacoLanguage: "javascript",
  supportLevel: "beta",
  entryFile: "main.js",
  imports: [String.raw`(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*["']([^"'\n]+)["']`],
  diagnostics: ["node"],
  template: [
    {
      path: "main.js",
      content: `console.log("Hello World");
`,
    },
  ],
  runtime: {
    image: "node:22-slim",
    command: ["node", NODE_STDIN_FLAG, "{entry}"],
  },
  debugger: { protocol: "inspector", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

const typescript: LanguageDefinition = {
  id: "typescript",
  name: "TypeScript",
  version: "Node.js 22 (type transform)",
  extensions: [".ts", ".mts"],
  monacoLanguage: "typescript",
  supportLevel: "beta",
  entryFile: "main.ts",
  imports: [String.raw`(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*["']([^"'\n]+)["']`],
  diagnostics: ["node"],
  template: [
    {
      path: "main.ts",
      content: `const greeting: string = "Hello World";
console.log(greeting);
`,
    },
  ],
  runtime: {
    image: "node:22-slim",
    // Transform (not just strip) so enums, namespaces and parameter properties work.
    command: ["node", "--experimental-transform-types", "--no-warnings", NODE_STDIN_FLAG, "{entry}"],
  },
  debugger: { protocol: "inspector", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

/** The JDK the Java sandbox uses, with the Kotlin compiler added (sandbox-images/kotlin). */
export const KOTLIN_IMAGE = "writecode/kotlin:2.2";
/** Where that image keeps Kotlin's standard library. */
const KOTLIN_STDLIB = "/opt/kotlinc/lib/kotlin-stdlib.jar";

const kotlin: LanguageDefinition = {
  id: "kotlin",
  name: "Kotlin",
  version: "2.2 (JVM 21)",
  extensions: [".kt"],
  monacoLanguage: "kotlin",
  supportLevel: "beta",
  entryFile: "Main.kt",
  entryPoints: "function-main",
  entryPattern: String.raw`^[ \t]*(?:suspend\s+)?fun\s+main\s*\(`,
  diagnostics: ["gcc", "jvm-trace"],
  template: [
    {
      path: "Main.kt",
      content: `fun main() {
    println("Hello World")
}
`,
    },
  ],
  compiler: {
    command: ["kotlinc", "-nowarn", "-d", "out", "{sources}"],
    sourceExtensions: [".kt"],
    builds: "program",
  },
  runtime: {
    image: KOTLIN_IMAGE,
    command: ["java", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xss8m", "-cp", `out:${KOTLIN_STDLIB}`, "{entryClass}"],
  },
  // The compiler alone needs about 400 MB.
  sandbox: { memoryMb: 640 },
  debugger: { protocol: "jdwp", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

/** golang with its standard library already compiled (sandbox-images/golang), so a build takes a second, not ten. */
export const GO_IMAGE = "writecode/golang:1.25";

/** Go with Delve and Python (sandbox-images/golang-dlv), for debugging and visualizing Go. */
export const GO_DLV_IMAGE = "writecode/golang-dlv:1.25";

const go: LanguageDefinition = {
  id: "go",
  name: "Go",
  version: "1.25",
  extensions: [".go"],
  monacoLanguage: "go",
  supportLevel: "beta",
  entryFile: "main.go",
  entryPoints: "function-main",
  entryPattern: String.raw`^func\s+main\s*\(`,
  diagnostics: ["go"],
  template: [
    {
      path: "main.go",
      content: `package main

import "fmt"

func main() {
	fmt.Println("Hello World")
}
`,
    },
  ],
  compiler: {
    command: ["go", "build", "-o", "out/main", "{sources}"],
    sourceExtensions: [".go"],
    builds: "program",
  },
  runtime: {
    image: GO_IMAGE,
    command: ["./out/main"],
  },
  debugger: {
    protocol: "delve",
    supportLevel: "beta",
    image: GO_DLV_IMAGE,
    // Optimisations off for the program's own package, so every line and variable is there; the standard library stays as compiled in the image.
    compiler: ["go", "build", "-gcflags=-N -l", "-o", "out/main", "{sources}"],
  },
  visualizer: { supportLevel: "beta" },
};

/** rust:1.90-slim with gdb and the toolchain's gdb printers (sandbox-images/rust-gdb), for debugging and visualizing Rust. */
export const RUST_GDB_IMAGE = "writecode/rust-gdb:1.90";

const rust: LanguageDefinition = {
  id: "rust",
  name: "Rust",
  version: "1.90",
  extensions: [".rs"],
  monacoLanguage: "rust",
  supportLevel: "beta",
  entryFile: "main.rs",
  entryPoints: "function-main",
  entryPattern: String.raw`^[ \t]*(?:pub\s+)?fn\s+main\s*\(`,
  diagnostics: ["rustc"],
  template: [
    {
      path: "main.rs",
      content: `fn main() {
    println!("Hello World");
}
`,
    },
  ],
  compiler: {
    // rustc is given the file the program starts in and finds its modules (\`mod name;\`) itself.
    // Overflow is checked, as `cargo run` checks it: `attempt to add with overflow` rather than a wrong number.
    command: ["rustc", "--edition", "2021", "-C", "opt-level=1", "-C", "debuginfo=0", "-C", "overflow-checks=on", "-o", "out/main", "{entry}"],
    sourceExtensions: [".rs"],
    builds: "program",
  },
  runtime: {
    image: "rust:1.90-slim",
    command: ["./out/main"],
  },
  debugger: {
    protocol: "gdb",
    supportLevel: "beta",
    image: RUST_GDB_IMAGE,
    compiler: ["rustc", "--edition", "2021", "-C", "opt-level=0", "-C", "debuginfo=2", "-C", "overflow-checks=on", "-o", "out/main", "{entry}"],
  },
  visualizer: { supportLevel: "beta" },
};

/** The .NET SDK with the C# compiler called directly (sandbox-images/dotnet): no project file, a build in about a second. */
export const DOTNET_IMAGE = "writecode/dotnet:8.0";

/** The .NET 8 SDK on Ubuntu with the same compiler wrapper as DOTNET_IMAGE, netcoredbg and Python (sandbox-images/dotnet-dbg), for debugging and visualizing C#. */
export const DOTNET_DBG_IMAGE = "writecode/dotnet-dbg:8.0";

const csharp: LanguageDefinition = {
  id: "csharp",
  name: "C#",
  version: ".NET 8 (C# 12)",
  extensions: [".cs"],
  monacoLanguage: "csharp",
  supportLevel: "beta",
  entryFile: "Program.cs",
  entryPoints: "function-main",
  entryPattern: String.raw`\bstatic\s+(?:async\s+)?[\w<>.\[\]]+\s+Main\s*\(`,
  diagnostics: ["csc", "dotnet-trace"],
  template: [
    {
      path: "Program.cs",
      content: `using System;

class Program
{
    static void Main(string[] args)
    {
        Console.WriteLine("Hello World");
    }
}
`,
    },
  ],
  compiler: {
    command: ["cw-csc", "out/main.dll", "{sources}"],
    sourceExtensions: [".cs"],
    builds: "program",
  },
  runtime: {
    image: DOTNET_IMAGE,
    command: ["dotnet", "out/main.dll"],
  },
  // The program is compiled the same way (portable symbols, no optimisation), so the debugger needs no compile of its own.
  debugger: { protocol: "netcoredbg", supportLevel: "beta", image: DOTNET_DBG_IMAGE },
  visualizer: { supportLevel: "beta" },
};

/** php:8.4-cli-alpine with Xdebug (not loaded in normal runs) and Python (sandbox-images/php-xdebug), for debugging and visualizing PHP. */
export const PHP_XDEBUG_IMAGE = "writecode/php-xdebug:8.4";

const php: LanguageDefinition = {
  id: "php",
  name: "PHP",
  version: "8.4",
  extensions: [".php"],
  monacoLanguage: "php",
  supportLevel: "beta",
  entryFile: "main.php",
  imports: [String.raw`\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']/?([^"'\n]+)["']`],
  diagnostics: ["php"],
  template: [
    {
      path: "main.php",
      content: `<?php

echo "Hello World\n";
`,
    },
  ],
  runtime: {
    image: "php:8.4-cli-alpine",
    // Errors once, on the error stream (the default prints them on both).
    command: ["php", "-d", "display_errors=stderr", "-d", "log_errors=0", "{entry}"],
  },
  debugger: { protocol: "dbgp", supportLevel: "beta", image: PHP_XDEBUG_IMAGE },
  visualizer: { supportLevel: "beta" },
};

const ruby: LanguageDefinition = {
  id: "ruby",
  name: "Ruby",
  version: "3.4",
  extensions: [".rb"],
  monacoLanguage: "ruby",
  supportLevel: "beta",
  entryFile: "main.rb",
  imports: [String.raw`^[ \t]*require_relative\s+["']([^"'\n]+)["']`, String.raw`^[ \t]*(?:require|load)\s+["']\.\/([^"'\n]+)["']`],
  diagnostics: ["ruby"],
  template: [
    {
      path: "main.rb",
      content: `puts "Hello World"
`,
    },
  ],
  runtime: {
    image: "ruby:3.4-alpine",
    // What is printed shows at once (a prompt before its answer is typed), as in a terminal; the file still runs as the program ($0).
    command: ["ruby", "-e", "$stdout.sync = $stderr.sync = true; $0 = ARGV.shift; load $0", "{entry}"],
  },
  debugger: { protocol: "tracepoint", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

const bash: LanguageDefinition = {
  id: "bash",
  name: "Bash",
  version: "5.2",
  extensions: [".sh"],
  monacoLanguage: "shell",
  supportLevel: "beta",
  entryFile: "main.sh",
  imports: [String.raw`^[ \t]*(?:source|\.)[ \t]+["']?(?:\.\/)?([^"'\s;]+)`],
  diagnostics: ["bash"],
  template: [
    {
      path: "main.sh",
      content: `#!/bin/bash

echo "Hello World"
`,
    },
  ],
  runtime: {
    // The Python image is Debian with bash and the usual tools (awk, sed, grep, sort).
    image: "python:3.13-slim",
    command: ["bash", "{entry}"],
  },
  // A DEBUG trap reports every command; Python in the same image drives it.
  debugger: { protocol: "bashtrap", supportLevel: "beta" },
  visualizer: { supportLevel: "beta" },
};

const sql: LanguageDefinition = {
  id: "sql",
  name: "SQL",
  version: "SQLite 3",
  extensions: [".sql"],
  monacoLanguage: "sql",
  supportLevel: "beta",
  entryFile: "main.sql",
  diagnostics: ["plain"],
  output: "tables",
  database: { file: SQL_STATE_FILE },
  template: [
    {
      path: "main.sql",
      content: `-- Press Run: the rows of every query are shown as a table.
-- The database keeps its tables between runs, so this script removes its own first.
DROP TABLE IF EXISTS students;

CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT,
  marks INTEGER
);

INSERT INTO students (name, city, marks) VALUES
  ('Asha', 'Hyderabad', 91),
  ('Ravi', 'Chennai', 78),
  ('Meera', 'Hyderabad', 85),
  ('John', 'Mumbai', 67);

SELECT name, city, marks
FROM students
ORDER BY marks DESC;

SELECT city, COUNT(*) AS students, ROUND(AVG(marks), 1) AS average
FROM students
GROUP BY city
ORDER BY average DESC;
`,
    },
  ],
  runtime: {
    image: "python:3.13-slim",
    command: ["python3", "-c", SQL_RUNNER, "{entry}"],
  },
};

const html: LanguageDefinition = {
  id: "html",
  name: "HTML, CSS, JS",
  version: "Runs in your browser",
  extensions: [".html", ".htm"],
  monacoLanguage: "html",
  supportLevel: "stable",
  entryFile: "index.html",
  diagnostics: [],
  preview: "browser",
  template: [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My page</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Hello World</h1>
    <p>You have clicked the button <span id="count">0</span> times.</p>
    <button id="button">Click me</button>

    <script src="script.js"></script>
  </body>
</html>
`,
    },
    {
      path: "style.css",
      content: `body {
  font-family: system-ui, sans-serif;
  max-width: 40rem;
  margin: 3rem auto;
  padding: 0 1rem;
  color: #1f2328;
}

button {
  padding: 0.5rem 1rem;
  border: 0;
  border-radius: 6px;
  background: #3574f0;
  color: white;
  font-size: 1rem;
  cursor: pointer;
}
`,
    },
    {
      path: "script.js",
      content: `const button = document.getElementById("button");
const count = document.getElementById("count");
let clicks = 0;

button.addEventListener("click", () => {
  clicks += 1;
  count.textContent = clicks;
  console.log("Clicked", clicks);
});
`,
    },
  ],
  // Nothing runs on the server: the page is shown in a preview.
  runtime: { image: "", command: [] },
};

export const LANGUAGES: readonly LanguageDefinition[] = [java, python, cpp, c, javascript, typescript, html, kotlin, go, rust, csharp, php, ruby, sql, bash];

const byId = new Map(LANGUAGES.map((l) => [l.id, l]));

export function getLanguage(id: string): LanguageDefinition | undefined {
  return byId.get(id);
}

export function requireLanguage(id: string): LanguageDefinition {
  const lang = byId.get(id);
  if (!lang) throw new Error(`Unknown language: ${id}`);
  return lang;
}

export function isLanguageId(id: string): boolean {
  return byId.has(id);
}

/** Resolves the Monaco language for an arbitrary file path, falling back to plaintext. */
export function monacoLanguageForPath(path: string): string {
  const lower = path.toLowerCase();
  for (const lang of LANGUAGES) {
    if (lang.extensions.some((ext) => lower.endsWith(ext))) return lang.monacoLanguage;
  }
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  return "plaintext";
}
