import { blankCode, cMainBody, freeName, javaMainBody, type ReadInputResult } from "./read-input";

/**
 * Puts the lines that read input into a program that reads none: a count `n`,
 * then `n` numbers into `arr`. The lines go where the program starts (the top
 * of `main`, or the top of a script after its imports), with the import or
 * include they need, in the program's own indentation and with names it does
 * not already use. What the program did before, it still does; the values are
 * there to be used. Returns null when there is no place to put them.
 */
export function addInputReading(language: string, code: string, path = ""): ReadInputResult | null {
  const text = code.replace(/\r\n?/g, "\n");
  const result = language === "java" ? java(text) : language === "c" ? c(text, false) : language === "cpp" ? c(text, true) : language === "python" ? python(text) : language === "javascript" || language === "typescript" ? script(text, path) : null;
  return result && { ...result, input: "3\n1 2 3\n" };
}

type Added = Omit<ReadInputResult, "input">;

/** `lines` as the first statements of the body that starts at `start` (just inside its opening brace). */
function intoBody(code: string, start: number, lines: string[]): string {
  const rest = code.slice(start);
  // The indentation of the line the body opens on, and of its first statement when it has one on a line of its own.
  const opening = /^[ \t]*/.exec(code.slice(code.lastIndexOf("\n", start - 1) + 1))![0];
  const first = /^[ \t]*\n(?:[ \t]*\n)*([ \t]*)[^\s}]/.exec(rest);
  const indent = first ? first[1]! : `${opening}${opening.includes("\t") ? "\t" : "    "}`;
  const block = `\n${lines.map((l) => indent + l).join("\n")}`;
  // Something follows the brace on its own line (`{ return 0; }`, `{}`): it moves down a line.
  if (!/^[ \t]*\S/.test(rest)) return code.slice(0, start) + block + rest;
  const tail = rest.replace(/^[ \t]+/, "");
  return `${code.slice(0, start)}${block}\n${tail.startsWith("}") ? opening : indent}${tail}`;
}

/** Adds `line` before the first line that matches `before`, or after the leading lines that match `after`, or at the top. */
function addLine(code: string, line: string, before: RegExp | null, after: RegExp | null): string {
  const lines = code.split("\n");
  let at = before ? lines.findIndex((l) => before.test(l)) : -1;
  if (at === -1) {
    at = 0;
    if (after) for (let i = 0; i < lines.length; i++) if (after.test(lines[i]!)) at = i + 1;
  }
  lines.splice(at, 0, line);
  return lines.join("\n");
}

function java(code: string): Added | null {
  const body = javaMainBody(code);
  if (!body) return null;
  const taken = blankCode(code);
  const scanner = freeName(taken, ["in", "sc", "scanner", "reader"]);
  const n = freeName(taken, ["n", "count", "size"]);
  const arr = freeName(taken, ["arr", "numbers", "values"]);
  const i = freeName(taken, ["i", "k", "idx"]);
  let out = intoBody(code, body.start, [
    `Scanner ${scanner} = new Scanner(System.in);`,
    `int ${n} = ${scanner}.nextInt();`,
    `int[] ${arr} = new int[${n}];`,
    `for (int ${i} = 0; ${i} < ${n}; ${i}++) ${arr}[${i}] = ${scanner}.nextInt();`,
  ]);
  if (!/^\s*import\s+java\.util\.(Scanner|\*)\s*;/m.test(taken)) out = addLine(out, "import java.util.Scanner;", /^\s*import\s/, /^\s*package\s[^;]*;/);
  return { code: out, names: [n, arr] };
}

function c(code: string, cpp: boolean): Added | null {
  const body = cMainBody(code);
  if (!body) return null;
  const taken = blankCode(code);
  const n = freeName(taken, ["n", "count", "size"]);
  const arr = freeName(taken, ["arr", "numbers", "values"]);
  const i = freeName(taken, ["i", "k", "idx"]);
  let out = intoBody(
    code,
    body.start,
    cpp
      ? [`int ${n};`, `std::cin >> ${n};`, `std::vector<int> ${arr}(${n});`, `for (int ${i} = 0; ${i} < ${n}; ${i}++) std::cin >> ${arr}[${i}];`]
      : [`int ${n};`, `scanf("%d", &${n});`, `int ${arr}[${n}];`, `for (int ${i} = 0; ${i} < ${n}; ${i}++) scanf("%d", &${arr}[${i}]);`],
  );
  const include = (header: string) => {
    if (!new RegExp(`^\\s*#\\s*include\\s*<${header.replace(".", "\\.")}>`, "m").test(code)) out = addLine(out, `#include <${header}>`, /^\s*#\s*include\b/, null);
  };
  if (cpp) {
    // <bits/stdc++.h> brings both.
    if (!/^\s*#\s*include\s*<bits\/stdc\+\+\.h>/m.test(code)) {
      include("vector");
      include("iostream");
    }
  } else include("stdio.h");
  return { code: out, names: [n, arr] };
}

/** The line a script's own statements start at: after its opening comments and its imports. */
function afterImports(lines: string[], isComment: (l: string) => boolean, isImport: (l: string) => boolean): number {
  let at = 0;
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (open > 0) {
      // Inside an import that runs over several lines.
      open += (l.match(/[({]/g)?.length ?? 0) - (l.match(/[)}]/g)?.length ?? 0);
      at = i + 1;
      continue;
    }
    if (!l.trim() || isComment(l)) continue;
    if (!isImport(l)) break;
    open = Math.max(0, (l.match(/[({]/g)?.length ?? 0) - (l.match(/[)}]/g)?.length ?? 0));
    at = i + 1;
  }
  // No imports: after the comments the file opens with (a shebang, a licence).
  if (at === 0) while (at < lines.length && lines[at]!.trim() && isComment(lines[at]!)) at++;
  return at;
}

function python(code: string): Added | null {
  const taken = code.replace(/#[^\n]*/g, "");
  const n = freeName(taken, ["n", "count", "size"]);
  const arr = freeName(taken, ["arr", "numbers", "values"]);
  const lines = code.split("\n");
  // A docstring the file opens with stays first.
  let from = 0;
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith("#"));
  const quote = first === -1 ? null : /^\s*[rRuU]?("""|''')/.exec(lines[first]!)?.[1];
  if (quote) {
    const sameLine = lines[first]!.indexOf(quote, lines[first]!.indexOf(quote) + 3) !== -1;
    const end = sameLine ? first : lines.findIndex((l, i) => i > first && l.includes(quote));
    if (end !== -1) from = end + 1;
  }
  const at = from + afterImports(lines.slice(from), (l) => l.trim().startsWith("#"), (l) => /^(import|from)\s/.test(l));
  const added = [`${n} = int(input())`, `${arr} = list(map(int, input().split()))`];
  const rest = lines.slice(at);
  lines.splice(at, 0, ...(at > 0 && lines[at - 1]!.trim() ? [""] : []), ...added, ...(rest.length && rest[0]!.trim() ? [""] : []));
  return { code: lines.join("\n"), names: [n, arr] };
}

function script(code: string, path: string): Added | null {
  const taken = blankCode(code);
  const data = freeName(taken, ["data", "inputData", "tokens"]);
  const n = freeName(taken, ["n", "count", "size"]);
  const arr = freeName(taken, ["arr", "numbers", "values"]);
  // A file written as a module cannot use require().
  const isModule = /\.(mjs|mts)$/i.test(path) || /^\s*(import\s[^(]|export\s)/m.test(taken);
  const read = isModule ? freeName(taken, ["readFileSync", "readInput"]) : "";
  const lines = code.split("\n");
  let block = false;
  const isComment = (l: string) => {
    const t = l.trim();
    if (block) {
      if (t.includes("*/")) block = false;
      return true;
    }
    if (t.startsWith("/*")) {
      block = !t.includes("*/");
      return true;
    }
    return t.startsWith("//") || /^["']use strict["'];?$/.test(t);
  };
  const at = afterImports(lines, isComment, (l) => /^\s*import\s/.test(l) || /^\s*(const|let|var)\s[^=]+=\s*require\s*\(/.test(l));
  const added = [
    ...(isModule ? [`import { readFileSync${read === "readFileSync" ? "" : ` as ${read}`} } from "node:fs";`] : []),
    `const ${data} = ${isModule ? read : 'require("fs").readFileSync'}(0, "utf8").trim().split(/\\s+/).map(Number);`,
    `const ${n} = ${data}[0];`,
    `const ${arr} = ${data}.slice(1, ${n} + 1);`,
  ];
  const rest = lines.slice(at);
  lines.splice(at, 0, ...(at > 0 && lines[at - 1]!.trim() ? [""] : []), ...added, ...(rest.length && rest[0]!.trim() ? [""] : []));
  return { code: lines.join("\n"), names: [n, arr] };
}
