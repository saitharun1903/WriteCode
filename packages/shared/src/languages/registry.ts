import type { LanguageDefinition } from "./types.js";

const java: LanguageDefinition = {
  id: "java",
  name: "Java",
  version: "21 (Temurin)",
  extensions: [".java"],
  monacoLanguage: "java",
  supportLevel: "stable",
  entryFile: "Main.java",
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
    command: ["javac", "-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1", "-g", "-encoding", "UTF-8", "-d", "out", "{sources}"],
    sourceExtensions: [".java"],
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

const cpp: LanguageDefinition = {
  id: "cpp",
  name: "C++",
  version: "GCC 14 (C++20)",
  extensions: [".cpp", ".cc", ".cxx", ".hpp", ".h"],
  monacoLanguage: "cpp",
  supportLevel: "stable",
  entryFile: "main.cpp",
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
  },
  runtime: {
    image: "gcc:14",
    command: ["./out/main"],
  },
  visualizer: { supportLevel: "planned" },
};

const c: LanguageDefinition = {
  id: "c",
  name: "C",
  version: "GCC 14 (C17)",
  extensions: [".c", ".h"],
  monacoLanguage: "c",
  supportLevel: "beta",
  entryFile: "main.c",
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
  },
  runtime: {
    image: "gcc:14",
    command: ["./out/main"],
  },
};

const javascript: LanguageDefinition = {
  id: "javascript",
  name: "JavaScript",
  version: "Node.js 22",
  extensions: [".js", ".mjs", ".cjs"],
  monacoLanguage: "javascript",
  supportLevel: "beta",
  entryFile: "main.js",
  template: [
    {
      path: "main.js",
      content: `console.log("Hello World");
`,
    },
  ],
  runtime: {
    image: "node:22-slim",
    command: ["node", "{entry}"],
  },
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
    command: ["node", "--experimental-transform-types", "--no-warnings", "{entry}"],
  },
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
