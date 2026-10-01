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

export const LANGUAGES: readonly LanguageDefinition[] = [java, python, cpp, c, javascript, typescript];

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
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md")) return "markdown";
  return "plaintext";
}
