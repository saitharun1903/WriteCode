import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_INPUT_EXAMPLE, getLanguage, readsInput } from "@cw/shared";
import { addInputReading } from "./add-input";

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const lines = (...l: string[]) => l.join(NL) + NL;

/** Programs that read no input, in the shapes people write them: [language, file, image, code]. */
const CASES: [string, string, string, string, string][] = [
  ["java: the starter", "java", "Main.java", "eclipse-temurin:21-jdk", getLanguage("java")!.template[0]!.content],
  [
    "java: tabs, a package of imports, names already used",
    "java",
    "Main.java",
    "eclipse-temurin:21-jdk",
    lines("import java.util.*;", "", "public class Main {", `${TAB}static int n = 2;`, `${TAB}public static void main(String[] args) throws Exception {`, `${TAB}${TAB}int in = 5, arr = 7, i = 1;`, `${TAB}${TAB}System.out.println(in + arr + i + n);`, `${TAB}}`, "}"),
  ],
  ["java: the body on the header's line", "java", "Main.java", "eclipse-temurin:21-jdk", lines("public class Main {", '  public static void main(String... a) { System.out.println("one line"); }', "}")],
  ["c: the starter", "c", "main.c", "gcc:14", getLanguage("c")!.template[0]!.content],
  ["c: an empty main with no include", "c", "main.c", "gcc:14", lines("int main() {}")],
  ["c: a function before main", "c", "main.c", "gcc:14", lines("#include <stdio.h>", "", "static int twice(int n) { return n * 2; }", "", "int main(void)", "{", '  printf("%d", twice(4));', "  return 0;", "}")],
  ["cpp: the starter", "cpp", "main.cpp", "gcc:14", getLanguage("cpp")!.template[0]!.content],
  ["cpp: bits/stdc++.h and using namespace std", "cpp", "main.cpp", "gcc:14", lines("#include <bits/stdc++.h>", "using namespace std;", "", "int main() {", "    vector<int> arr = {1, 2};", '    cout << arr.size() << "\\n";', "}")],
  ["python: the starter", "python", "main.py", "python:3.13-slim", getLanguage("python")!.template[0]!.content],
  [
    "python: a docstring, imports over several lines, and a value named n",
    "python",
    "main.py",
    "python:3.13-slim",
    lines("#!/usr/bin/env python3", '"""Adds numbers."""', "import sys", "from math import (", "    floor,", "    sqrt,", ")", "", "n = 4", "print(floor(sqrt(n)), sys.argv[0] != '')"),
  ],
  ["python: one line", "python", "main.py", "python:3.13-slim", 'print("hi")'],
  ["javascript: the starter", "javascript", "main.js", "node:22-slim", getLanguage("javascript")!.template[0]!.content],
  ["javascript: use strict, a comment and a require", "javascript", "main.js", "node:22-slim", lines('"use strict";', "/* adds", "   numbers */", 'const path = require("path");', "const data = [1, 2];", "console.log(path.basename(__filename), data.length);")],
  ["javascript: a module", "javascript", "main.mjs", "node:22-slim", lines('import { basename } from "node:path";', "", 'console.log(basename("/a/b.txt"));')],
  ["typescript: the starter", "typescript", "main.ts", "node:22-slim", getLanguage("typescript")!.template[0]!.content],
  ["typescript: a module with types", "typescript", "main.ts", "node:22-slim", lines('import { basename } from "node:path";', "", "interface Named { name: string }", 'const file: Named = { name: basename("/a/b.txt") };', "console.log(file.name);")],
];

describe("adding the lines that read input", () => {
  it.each(CASES)("%s: the program then reads its input, and keeps its own code", (_name, language, file, _image, code) => {
    const result = addInputReading(language, code, file)!;
    expect(result).toBeTruthy();
    expect(result.input).toBe(`3${NL}1 2 3${NL}`);
    expect(result.names).toHaveLength(2);
    // The notice that offered it goes away: the program reads now.
    expect(readsInput(language, [{ path: file, content: code }])).toBe(false);
    expect(readsInput(language, [{ path: file, content: result.code }])).toBe(true);
    // Every line of the original is still there, in order.
    const kept = code.split(NL).filter((l) => l.trim());
    let at = 0;
    for (const line of result.code.split(NL)) if (at < kept.length && line.trim() === kept[at]!.trim()) at++;
    if (!/[{(]\s*\S.*}\s*$/m.test(code)) expect(at).toBe(kept.length);
    // Doing it twice is not offered (the program reads input), and the names do not clash.
    expect(new Set(result.names).size).toBe(2);
  });

  it("puts the lines where the program starts, in its own indentation", () => {
    const java = addInputReading("java", getLanguage("java")!.template[0]!.content)!.code.split(NL);
    expect(java[0]).toBe("import java.util.Scanner;");
    const main = java.findIndex((l) => l.includes("static void main"));
    expect(java.slice(main + 1, main + 5)).toEqual([
      "        Scanner in = new Scanner(System.in);",
      "        int n = in.nextInt();",
      "        int[] arr = new int[n];",
      "        for (int i = 0; i < n; i++) arr[i] = in.nextInt();",
    ]);
    expect(java[main + 5]).toContain('System.out.println("Hello World");');

    const tabs = addInputReading("java", CASES[1]![4])!;
    // Names the program already uses are left to it.
    expect(tabs.names).toEqual(["count", "numbers"]);
    expect(tabs.code).toContain(`${TAB}${TAB}Scanner sc = new Scanner(System.in);`);
    expect(tabs.code.match(/import java\.util/g)).toHaveLength(1);

    const py = addInputReading("python", CASES[9]![4])!;
    const pyLines = py.code.split(NL);
    expect(pyLines.slice(0, 7)).toEqual(CASES[9]![4].split(NL).slice(0, 7));
    expect(py.names).toEqual(["count", "arr"]);
    expect(pyLines.indexOf("count = int(input())")).toBe(8);

    const mjs = addInputReading("javascript", CASES[13]![4], "main.mjs")!.code;
    expect(mjs).toContain('import { readFileSync } from "node:fs";');
    expect(mjs).not.toContain("require(");
    expect(addInputReading("javascript", 'console.log("x");', "main.js")!.code).toContain('require("fs")');
  });

  it("has nothing to add where a program has no place to start, and for every language an example to show", () => {
    expect(addInputReading("java", "public class Main { }")).toBeNull();
    expect(addInputReading("c", "int helper(void) { return 1; }")).toBeNull();
    expect(addInputReading("cobol", "DISPLAY 'x'.")).toBeNull();
    for (const id of ["java", "python", "c", "cpp", "javascript", "typescript"]) expect(READ_INPUT_EXAMPLE[id], id).toBeTruthy();
  });
});

/** Compiles (where needed) and runs `file` in its real image with `stdin`. */
const run = (image: string, dir: string, file: string, stdin: string) => {
  const cmd = file.endsWith(".java")
    ? `javac -Xlint:all -Werror -d /tmp/o ${file} && java -cp /tmp/o Main`
    : file.endsWith(".c")
      ? `gcc -std=c17 -O2 -Wall -o /tmp/m ${file} -lm && /tmp/m`
      : file.endsWith(".cpp")
        ? `g++ -std=c++20 -O2 -Wall -o /tmp/m ${file} && /tmp/m`
        : file.endsWith(".py")
          ? `python3 ${file}`
          : file.endsWith(".ts")
            ? `node --experimental-transform-types --no-warnings ${file}`
            : `node ${file}`;
  return execFileSync("docker", ["run", "--rm", "-i", "-v", `${dir}:/w`, "-w", "/w", image, "sh", "-c", cmd], { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
};

/**
 * Runs each changed program in its real image: it must still compile and
 * print exactly what it printed before, now that it reads its input first.
 * Needs Docker; run with VERIFY_READ_INPUT=1.
 */
describe.skipIf(!process.env.VERIFY_READ_INPUT)("adding input reading: the program still works", () => {
  it.each(CASES)("%s", { timeout: 180_000 }, (_name, language, file, image, code) => {
    const result = addInputReading(language, code, file)!;
    const dir = mkdtempSync(join(tmpdir(), "cw-ai-"));
    writeFileSync(join(dir, file), code);
    const before = run(image, dir, file, "");
    writeFileSync(join(dir, file), result.code);
    expect(run(image, dir, file, result.input)).toBe(before);
  });
});
