/**
 * Rewrites values fixed in the code so the program reads them from its input
 * instead, the change people make by hand when they start testing a program:
 *
 *   int arr[] = {3, 4, 6};   ->  int[] arr = new int[in.nextInt()];
 *                                for (int i = 0; i < arr.length; i++) arr[i] = in.nextInt();
 *   int n = 5;               ->  int n = in.nextInt();
 *
 * It also returns the original values as input text in the order they are now
 * read, so the program prints exactly what it printed before. Only simple
 * literal declarations directly in `main` (Java, C, C++) or at the top level
 * (Python, JavaScript, TypeScript; Python's `main()` too) are changed; anything
 * else is left alone.
 */
export interface ReadInputResult {
  code: string;
  /** The values that were in the code, as input in the order they are read. */
  input: string;
  /** Names of the variables now read from input, in order. */
  names: string[];
}

type JavaScalar = "int" | "long" | "double" | "float" | "short" | "byte" | "boolean" | "char" | "String";

const JAVA_READ: Record<JavaScalar, string> = {
  int: "nextInt()",
  long: "nextLong()",
  double: "nextDouble()",
  float: "nextFloat()",
  short: "nextShort()",
  byte: "nextByte()",
  boolean: "nextBoolean()",
  char: "next().charAt(0)",
  String: "next()",
};

const NUMBER = /^-?\d+(?:\.\d+)?[lLfFdD]?$/;

/** A literal as input text, or null when it cannot be typed as one input token. */
function javaToken(type: JavaScalar, literal: string): string | null {
  const v = literal.trim();
  if (type === "String") {
    const m = /^"((?:\\.|[^"\\])*)"$/.exec(v);
    return m && m[1] && !/[\s\\]/.test(m[1]) ? m[1] : null;
  }
  if (type === "char") {
    const m = /^'([^'\\\s])'$/.exec(v);
    return m ? m[1]! : null;
  }
  if (type === "boolean") return v === "true" || v === "false" ? v : null;
  return NUMBER.test(v) ? v.replace(/[lLfFdD]$/, "") : null;
}

/** Blanks comments and string/char literals (same length) so braces inside them do not count. */
export function blankCode(code: string): string {
  return blankJava(code);
}

function blankJava(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Start and end offsets of main's body (just inside its braces). */
export function javaMainBody(code: string): { start: number; end: number } | null {
  const clean = blankJava(code);
  const head = /\bstatic\s+void\s+main\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{/.exec(clean) ?? /\bvoid\s+main\s*\(\s*\)\s*\{/.exec(clean);
  if (!head) return null;
  const start = head.index + head[0].length;
  let depth = 1;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}" && --depth === 0) return { start, end: i };
  }
  return null;
}

/** Whether `name` is assigned or incremented anywhere in `code` (after its declaration). */
function changesLater(code: string, name: string): boolean {
  const clean = blankJava(code);
  const n = name.replace(/[$]/g, "\\$");
  return new RegExp(`(^|[^\\w$.])${n}\\s*([-+*/%&|^]|<<|>>)?=(?!=)|(\\+\\+|--)\\s*${n}\\b|\\b${n}\\s*(\\+\\+|--)`).test(clean.replace(new RegExp(`^.*\\b${n}\\b[^\\n]*=`, "m"), ""));
}

export function freeName(taken: string, wanted: string[]): string {
  return wanted.find((n) => !new RegExp(`\\b${n}\\b`).test(taken)) ?? `${wanted[0]}${Date.now() % 1000}`;
}

export function javaReadInput(code: string): ReadInputResult | null {
  const body = javaMainBody(code);
  if (!body) return null;
  const inner = code.slice(body.start, body.end);
  const lines = inner.split("\n");
  // Only statements directly in main, not inside its loops or blocks.
  let depth = 0;
  const cleanLines = blankJava(inner).split("\n");
  const scanner = /\bnew\s+Scanner\s*\(\s*System\.in\s*\)/.test(inner) ? /(\w+)\s*=\s*new\s+Scanner\s*\(\s*System\.in\s*\)/.exec(inner)?.[1] : undefined;
  const reader = scanner ?? freeName(inner, ["in", "sc", "scanner"]);
  const tokens: string[] = [];
  const names: string[] = [];
  const decl = /^(\s*)(?:final\s+)?(int|long|double|float|short|byte|boolean|char|String)\s*(\[\])?\s+(\w+)\s*(\[\])?\s*=\s*(.+?);\s*(\/\/.*)?$/;
  let firstIndent: string | null = null;
  for (const [i, line] of lines.entries()) {
    const atTop = depth === 0;
    for (const ch of cleanLines[i]!) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!atTop) continue;
    if (firstIndent === null && line.trim()) firstIndent = /^\s*/.exec(line)![0];
    const m = decl.exec(line);
    if (!m) continue;
    const [, indent, typeName, arr1, name, arr2, rawValue] = m;
    const type = typeName as JavaScalar;
    const isArray = !!(arr1 || arr2);
    let value = rawValue!.trim();
    if (isArray) {
      const list = /^(?:new\s+\w+\s*\[\s*\]\s*)?\{(.*)\}$/.exec(value);
      if (!list) continue;
      const items = list[1]!.trim() ? list[1]!.split(",").map((x) => x.trim()) : [];
      const parts = items.map((x) => javaToken(type, x));
      if (parts.some((p) => p === null)) continue;
      const index = freeName(inner, ["i", "j", "k", "idx"]);
      lines[i] =
        `${indent}${type}[] ${name} = new ${type}[${reader}.nextInt()];\n` +
        `${indent}for (int ${index} = 0; ${index} < ${name}.length; ${index}++) ${name}[${index}] = ${reader}.${JAVA_READ[type]};`;
      tokens.push(String(items.length), parts.join(" "));
    } else {
      value = value.replace(/^\((\w+)\)\s*/, "");
      const token = javaToken(type, value);
      if (token === null) continue;
      lines[i] = `${indent}${type} ${name} = ${reader}.${JAVA_READ[type]};`;
      tokens.push(token);
    }
    names.push(name!);
  }
  if (!names.length) return null;

  let newInner = lines.join("\n");
  if (!scanner) {
    // The reader goes first in main, at the indentation of main's first statement.
    const indent = firstIndent ?? "        ";
    const lead = /^[ \t]*\n?/.exec(newInner)![0];
    newInner = `${lead.endsWith("\n") ? lead : `${lead}\n`}${indent}Scanner ${reader} = new Scanner(System.in);\n${newInner.slice(lead.length)}`;
  }
  let next = code.slice(0, body.start) + newInner + code.slice(body.end);
  if (!/^\s*import\s+java\.util\.(?:Scanner|\*)\s*;/m.test(next)) {
    const pkg = /^\s*package\s+[\w.]+\s*;[^\n]*\n/m.exec(next);
    const at = pkg ? pkg.index + pkg[0].length : 0;
    const hasImports = /^\s*import\s/m.test(next);
    next = next.slice(0, at) + (pkg ? "\n" : "") + "import java.util.Scanner;\n" + (hasImports ? "" : "\n") + next.slice(at).replace(/^\n+/, hasImports ? "" : "");
  }
  return { code: next, input: tokens.join("\n") + "\n", names };
}

const PY_NUMBER = /^-?\d+(?:\.\d+)?$/;

export function pythonReadInput(code: string): ReadInputResult | null {
  const lines = code.split("\n");
  // Top-level statements, plus the bodies of `def main():` and `if __name__ == "__main__":`.
  let block: string | null = null;
  const tokens: string[] = [];
  const names: string[] = [];
  for (const [i, line] of lines.entries()) {
    const indent = /^\s*/.exec(line)![0];
    if (!indent && line.trim()) {
      block = /^(?:def\s+main\s*\(\s*\)|if\s+__name__\s*==\s*["']__main__["'])\s*:/.test(line) ? "main" : null;
    }
    const inScope = indent === "" || (block === "main" && indent.length === 4);
    if (!inScope) continue;
    const m = /^(\s*)(\w+)\s*=\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!m) continue;
    const [, ind, name, value] = m;
    let replacement: string | null = null;
    let token: string | null = null;
    const list = /^\[(.*)\]$/.exec(value!);
    if (PY_NUMBER.test(value!)) {
      replacement = `${ind}${name} = ${value!.includes(".") ? "float" : "int"}(input())`;
      token = value!;
    } else if (/^(["'])([^"'\s\\]+)\1$/.test(value!)) {
      replacement = `${ind}${name} = input()`;
      token = value!.slice(1, -1);
    } else if (list) {
      const items = list[1]!.trim() ? list[1]!.split(",").map((x) => x.trim()) : [];
      if (items.length && items.every((x) => PY_NUMBER.test(x))) {
        const kind = items.some((x) => x.includes(".")) ? "float" : "int";
        replacement = `${ind}${name} = list(map(${kind}, input().split()))`;
        token = items.join(" ");
      } else if (items.length && items.every((x) => /^(["'])([^"'\s\\]+)\1$/.test(x))) {
        replacement = `${ind}${name} = input().split()`;
        token = items.map((x) => x.slice(1, -1)).join(" ");
      }
    }
    if (replacement === null || token === null) continue;
    lines[i] = replacement;
    tokens.push(token);
    names.push(name!);
  }
  if (!names.length) return null;
  return { code: lines.join("\n"), input: tokens.join("\n") + "\n", names };
}

// -- C and C++

/** C types a literal can be read into, with their scanf conversion. */
const C_TYPES: Record<string, string> = {
  int: "%d",
  short: "%hd",
  long: "%ld",
  "long long": "%lld",
  unsigned: "%u",
  "unsigned int": "%u",
  "unsigned long": "%lu",
  "unsigned long long": "%llu",
  float: "%f",
  double: "%lf",
  char: " %c",
};
const C_TYPE = /(unsigned\s+long\s+long|unsigned\s+long|unsigned\s+int|unsigned|long\s+long|long|short|int|float|double|char|bool|std::string|string)/;

function cToken(type: string, literal: string): string | null {
  const v = literal.trim();
  if (type === "char") {
    const m = /^'([^'\\\s])'$/.exec(v);
    return m ? m[1]! : null;
  }
  if (type === "string" || type === "std::string") {
    const m = /^"((?:\\.|[^"\\])*)"$/.exec(v);
    return m && m[1] && !/[\s\\]/.test(m[1]) ? m[1] : null;
  }
  if (type === "bool") return v === "true" ? "1" : v === "false" ? "0" : /^[01]$/.test(v) ? v : null;
  return /^-?\d+(?:\.\d+)?(?:[uUlLfF]*)$/.test(v) ? v.replace(/[uUlLfF]+$/, "") : null;
}

/** Start and end offsets of `int main(...)`'s body (just inside its braces). */
export function cMainBody(code: string): { start: number; end: number } | null {
  const clean = blankJava(code);
  const head = /\bint\s+main\s*\([^)]*\)\s*\{/.exec(clean);
  if (!head) return null;
  const start = head.index + head[0].length;
  let depth = 1;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}" && --depth === 0) return { start, end: i };
  }
  return null;
}

/**
 * C and C++: `int n = 5;` reads n with scanf (C) or cin (C++); `int arr[] = {…}`
 * and `vector<int> v = {…}` read how many, then the values.
 */
export function cReadInput(code: string, cpp: boolean): ReadInputResult | null {
  const body = cMainBody(code);
  if (!body) return null;
  const inner = code.slice(body.start, body.end);
  const lines = inner.split("\n");
  const cleanLines = blankJava(inner).split("\n");
  const std = cpp && !/\busing\s+namespace\s+std\s*;/.test(code) ? "std::" : "";
  const read = (target: string, type: string) => (cpp ? `${std}cin >> ${target};` : `scanf("${C_TYPES[type] ?? "%d"}", &${target});`);
  const tokens: string[] = [];
  const names: string[] = [];
  let depth = 0;
  const scalar = new RegExp(`^(\\s*)(?:const\\s+)?${C_TYPE.source}\\s+(\\w+)\\s*=\\s*(.+?);\\s*(//.*)?$`);
  const array = new RegExp(`^(\\s*)(?:const\\s+)?${C_TYPE.source}\\s+(\\w+)\\s*\\[\\s*(\\d*)\\s*\\]\\s*=\\s*\\{(.*)\\}\\s*;\\s*(//.*)?$`);
  const vector = /^(\s*)(?:const\s+)?(?:std::)?vector\s*<\s*(int|long|long long|double|float|char|std::string|string)\s*>\s+(\w+)\s*=\s*\{(.*)\}\s*;\s*(\/\/.*)?$/;
  for (const [i, line] of lines.entries()) {
    const atTop = depth === 0;
    for (const ch of cleanLines[i]!) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (!atTop) continue;
    const index = freeName(inner, ["i", "j", "k", "idx"]);
    let m = vector.exec(line);
    if (m && cpp) {
      const [, indent, type, name, list] = m;
      const items = list!.trim() ? list!.split(",").map((x) => x.trim()) : [];
      const parts = items.map((x) => cToken(type!, x));
      if (!items.length || parts.some((p) => p === null)) continue;
      const count = freeName(inner, [`${name}_size`, `${name}Size`]);
      lines[i] =
        `${indent}int ${count};\n${indent}${std}cin >> ${count};\n` +
        `${indent}${std}vector<${type}> ${name}(${count});\n` +
        `${indent}for (int ${index} = 0; ${index} < ${count}; ${index}++) ${std}cin >> ${name}[${index}];`;
      tokens.push(String(items.length), parts.join(" "));
      names.push(name!);
      continue;
    }
    m = array.exec(line);
    if (m) {
      const [, indent, rawType, name, size, list] = m;
      const type = rawType!.replace(/\s+/g, " ");
      const items = list!.trim() ? list!.split(",").map((x) => x.trim()) : [];
      const parts = items.map((x) => cToken(type, x));
      // A size bigger than the values leaves room the program may use: keep such arrays as they are.
      if (!items.length || parts.some((p) => p === null) || (size && Number(size) !== items.length) || type === "char") continue;
      const count = freeName(inner, [`${name}_size`, `${name}Size`]);
      lines[i] =
        `${indent}int ${count};\n${indent}${read(count, "int")}\n` +
        `${indent}${type} ${name}[${count}];\n` +
        `${indent}for (int ${index} = 0; ${index} < ${count}; ${index}++) ${read(`${name}[${index}]`, type)}`;
      tokens.push(String(items.length), parts.join(" "));
      names.push(name!);
      continue;
    }
    m = scalar.exec(line);
    if (m) {
      const [, indent, rawType, name, value] = m;
      const type = rawType!.replace(/\s+/g, " ");
      if (!cpp && (type === "string" || type === "std::string" || type === "bool")) continue;
      const token = cToken(type, value!.replace(/^\((\w+)\)\s*/, ""));
      if (token === null || changesLater(inner, name!)) continue;
      lines[i] = `${indent}${type} ${name};\n${indent}${read(name!, type)}`;
      tokens.push(token);
      names.push(name!);
    }
  }
  if (!names.length) return null;
  let next = code.slice(0, body.start) + lines.join("\n") + code.slice(body.end);
  const header = cpp ? "iostream" : "stdio.h";
  if (!new RegExp(`#\\s*include\\s*<${header.replace(".", "\\.")}>`).test(next) && !(cpp && /#\s*include\s*<bits\/stdc\+\+\.h>/.test(next))) {
    next = `#include <${header}>\n${next}`;
  }
  return { code: next, input: tokens.join("\n") + "\n", names };
}

// -- JavaScript and TypeScript

/**
 * JavaScript and TypeScript: top-level `const n = 5;` reads the next value of
 * the input; `const arr = [1, 2, 3];` reads how many, then the values. The
 * whole input is read at once, which works in CommonJS and ES modules alike.
 */
export function jsReadInput(code: string, ts: boolean): ReadInputResult | null {
  const lines = code.split("\n");
  const clean = blankJava(code).split("\n");
  const tokens: string[] = [];
  const names: string[] = [];
  let depth = 0;
  const input = freeName(code, ["input", "tokens", "stdinTokens"]);
  const pos = freeName(code, ["pos", "cursor", "at"]);
  const decl = /^(\s*)(const|let|var)\s+(\w+)(\s*:\s*[\w[\]<>]+)?\s*=\s*(.+?);?\s*(\/\/.*)?$/;
  for (const [i, line] of lines.entries()) {
    const atTop = depth === 0;
    for (const ch of clean[i]!) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (!atTop || depth !== 0) continue;
    const m = decl.exec(line);
    if (!m) continue;
    const [, indent, kind, name, annotation = "", value] = m;
    const v = value!.trim();
    const list = /^\[(.*)\]$/.exec(v);
    if (!list && changesLater(code, name!)) continue;
    if (/^-?\d+(?:\.\d+)?$/.test(v)) {
      lines[i] = `${indent}${kind} ${name}${annotation} = Number(${input}[${pos}++]);`;
      tokens.push(v);
    } else if (/^(["'`])([^"'`\s\\$]+)\1$/.test(v)) {
      lines[i] = `${indent}${kind} ${name}${annotation} = ${input}[${pos}++];`;
      tokens.push(v.slice(1, -1));
    } else if (list) {
      const items = list[1]!.trim() ? list[1]!.split(",").map((x) => x.trim()) : [];
      if (items.length && items.every((x) => /^-?\d+(?:\.\d+)?$/.test(x))) {
        lines[i] = `${indent}${kind} ${name}${annotation} = Array.from({ length: Number(${input}[${pos}++]) }, () => Number(${input}[${pos}++]));`;
        tokens.push(String(items.length), items.join(" "));
      } else if (items.length && items.every((x) => /^(["'])([^"'\s\\]+)\1$/.test(x))) {
        lines[i] = `${indent}${kind} ${name}${annotation} = Array.from({ length: Number(${input}[${pos}++]) }, () => ${input}[${pos}++]);`;
        tokens.push(String(items.length), items.map((x) => x.slice(1, -1)).join(" "));
      } else continue;
    } else continue;
    names.push(name!);
  }
  if (!names.length) return null;
  const esm = ts || /^\s*(import|export)\s/m.test(code);
  const reader = esm
    ? [`import { readFileSync } from "node:fs";`, "", `const ${input} = readFileSync(0, "utf8").split(/\\s+/).filter(Boolean);`, `let ${pos} = 0;`]
    : [`const ${input} = require("node:fs").readFileSync(0, "utf8").split(/\\s+/).filter(Boolean);`, `let ${pos} = 0;`];
  // After the file's own imports, so it stays a valid module.
  let at = 0;
  for (const [i, line] of lines.entries()) if (/^\s*(import\s|["']use strict["'])/.test(line)) at = i + 1;
  const imports = esm ? reader.slice(0, 1) : [];
  const rest = esm ? reader.slice(2) : reader;
  const hasFsImport = /from\s+["'](node:)?fs["']/.test(code) && /\breadFileSync\b/.test(code);
  lines.splice(at, 0, ...(hasFsImport ? [] : imports), ...rest, "");
  return { code: lines.join("\n"), input: tokens.join("\n") + "\n", names };
}

export function readInputFor(language: string, code: string): ReadInputResult | null {
  if (language === "java") return javaReadInput(code);
  if (language === "python") return pythonReadInput(code);
  if (language === "c" || language === "cpp") return cReadInput(code, language === "cpp");
  if (language === "javascript" || language === "typescript") return jsReadInput(code, language === "typescript");
  return null;
}

/** The arguments of each call to `fn(...)` in code (comments and strings blanked, but kept in the args). */
function callArgs(code: string, fn: RegExp): string[][] {
  const clean = blankJava(code);
  const out: string[][] = [];
  for (const m of clean.matchAll(fn)) {
    let depth = 0;
    const start = m.index! + m[0].length;
    let end = start;
    for (; end < clean.length; end++) {
      if (clean[end] === "(") depth++;
      else if (clean[end] === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    const text = code.slice(start, end);
    const args: string[] = [];
    let cur = "";
    let d = 0;
    let quote: string | null = null;
    for (const ch of text) {
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      if (ch === "(" || ch === "[") d++;
      if (ch === ")" || ch === "]") d--;
      if (ch === "," && d === 0) {
        args.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** What a C or C++ program reads, in order: scanf targets, `cin >>` targets, getline. */
function cReads(code: string): string[] {
  const out: string[] = [];
  const clean = blankJava(code);
  type Read = { at: number; items: string[] };
  const reads: Read[] = [];
  const target = (t: string, kind = "") => {
    const arr = /^&?\s*(\w+)\s*\[/.exec(t) ?? /^(\w+)\s*\+\s*\w+$/.exec(t);
    if (arr) return `${arr[1]}: values`;
    const name = /^&?\s*([A-Za-z_]\w*(?:\.\w+|->\w+)*)$/.exec(t);
    return name ? `${name[1]}${kind}` : "a value";
  };
  let i = 0;
  for (const args of callArgs(code, /\bscanf\s*\(/g)) {
    const at = clean.indexOf("scanf", i);
    i = at + 1;
    const fmt = /^"(.*)"$/.exec(args[0] ?? "")?.[1] ?? "";
    const conv = [...fmt.matchAll(/%[*]?\d*(?:hh|h|ll|l|L)?([diouxXfeEgGcs[])/g)].filter((c) => !c[0].includes("*")).map((c) => c[1]);
    reads.push({ at, items: args.slice(1).map((a, k) => target(a, conv[k] === "s" ? " (a word)" : conv[k] === "c" ? " (a character)" : "")) });
  }
  for (const m of clean.matchAll(/\b(?:std::)?cin((?:\s*>>\s*[^;>]+)+)\s*;/g)) {
    const parts = code.slice(m.index!, m.index! + m[0].length).split(">>").slice(1).map((x) => x.replace(/;\s*$/, "").trim());
    reads.push({ at: m.index!, items: parts.map((p) => target(p)) });
  }
  for (const m of clean.matchAll(/\bgetline\s*\(\s*(?:std::)?cin\s*,\s*(\w+)/g)) reads.push({ at: m.index!, items: [`${m[1]} (a line of text)`] });
  for (const r of reads.sort((a, b) => a.at - b.at)) {
    for (const item of r.items) {
      if (item.endsWith(": values") && out[out.length - 1] === item) continue;
      // `arr_size` read just before `arr: values`: one read of how many, then the values.
      const array = item.endsWith(": values") ? item.slice(0, -": values".length) : null;
      const prev = out[out.length - 1];
      if (array && (prev === `${array}_size` || prev === `${array}Size` || prev === "n" || prev === "size" || prev === "len")) {
        out[out.length - 1] = `${array}: how many, then the values`;
        continue;
      }
      out.push(item);
    }
  }
  return out;
}

/** What a JavaScript or TypeScript program reads: whole input, lines, or tokens taken one by one. */
function jsReads(code: string): string[] {
  const out: string[] = [];
  const clean = blankJava(code);
  for (const line of clean.split("\n")) {
    const reads = [...line.matchAll(/\b(input|tokens|stdinTokens|data|words)\[\s*\w+\+\+\s*\]/g)].length;
    if (!reads) continue;
    const name = /(?:const|let|var)\s+(\w+)/.exec(line)?.[1];
    if (name && /Array\.from\(\s*\{\s*length:/.test(line)) out.push(`${name}: how many, then the values`);
    else if (name && reads === 1) out.push(name);
    else for (let k = 0; k < reads; k++) out.push("a value");
  }
  if (out.length) return out;
  if (/readFileSync\s*\(\s*(0|["']\/dev\/stdin["'])/.test(clean)) return ["the whole input (all lines at once)"];
  if (/\.on\s*\(\s*["']line["']|\bfor\s+await\s*\(.*\brl\b|\.question\s*\(/.test(code)) return ["lines of text, one at a time"];
  return out;
}

/**
 * What a program reads from its input, in order, worked out from its code so
 * a test's input can be written to match: e.g. ["arr: how many, then the
 * values", "n"]. Java looks at main; Python, C, C++, JavaScript and TypeScript
 * at the whole file. Reads it cannot name (inside expressions) are listed as
 * "a value".
 */
export function describeReads(language: string, code: string): string[] {
  const out: string[] = [];
  if (language === "c" || language === "cpp") return cReads(code);
  if (language === "javascript" || language === "typescript") return jsReads(code);
  if (language === "java") {
    const body = javaMainBody(code);
    if (!body) return out;
    const inner = blankJava(code.slice(body.start, body.end));
    const sized = new Map<string, string>(); // array -> its size variable
    const counted = new Set<string>(); // arrays whose size was read from input
    const kind = (m: string) => (m === "nextLine" ? " (a line of text)" : m === "next" ? " (a word)" : "");
    for (const line of inner.split("\n")) {
      const withCount = /(\w+)\s*=\s*new\s+\w+\s*\[\s*\w+\.next\w*\(\)\s*\]/.exec(line);
      if (withCount) {
        counted.add(withCount[1]!);
        out.push(`${withCount[1]}: how many, then the values`);
        continue;
      }
      const sizedBy = /(\w+)\s*=\s*new\s+\w+\s*\[\s*(\w+)\s*\]/.exec(line);
      if (sizedBy) sized.set(sizedBy[1]!, sizedBy[2]!);
      const element = /(\w+)\s*\[[^\]]+\]\s*=\s*\w+\.next\w*\(\)/.exec(line);
      if (element) {
        if (!counted.has(element[1]!)) out.push(`${element[1]}: ${sized.get(element[1]!) ?? "several"} values`);
        continue;
      }
      for (const m of line.matchAll(/(?:(\w+)\s*=\s*)?\b\w+\.(nextInt|nextLong|nextDouble|nextFloat|nextShort|nextByte|nextBoolean|nextLine|next)\(\)/g)) {
        out.push(m[1] ? `${m[1]}${kind(m[2]!)}` : "a value");
      }
    }
    return out;
  }
  if (language === "python") {
    for (const raw of code.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      const many = /^\s*([\w\s,]+?)\s*=\s*map\(\w+,\s*input\(\)\.split\(\)\)/.exec(line);
      if (many) {
        out.push(`${many[1]!.split(",").map((s) => s.trim()).join(" ")} on one line`);
        continue;
      }
      const list = /^\s*(\w+)\s*=\s*(?:list\(map\(\w+,\s*input\(\)\.split\(\)\)\)|input\(\)\.split\(\))/.exec(line);
      if (list) {
        out.push(`${list[1]}: values on one line`);
        continue;
      }
      for (const m of line.matchAll(/(?:(\w+)\s*=\s*)?(?:(int|float)\()?input\(\)/g)) out.push(m[1] ? `${m[1]}${m[2] ? "" : " (a line of text)"}` : "a value");
    }
  }
  return out;
}
