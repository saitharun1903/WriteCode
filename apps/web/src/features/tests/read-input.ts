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
 * literal declarations directly in `main` (Java) or at the top level / in
 * `main()` (Python) are changed; anything else is left alone.
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
function blankJava(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Start and end offsets of main's body (just inside its braces). */
function javaMainBody(code: string): { start: number; end: number } | null {
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

function freeName(taken: string, wanted: string[]): string {
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

export function readInputFor(language: string, code: string): ReadInputResult | null {
  if (language === "java") return javaReadInput(code);
  if (language === "python") return pythonReadInput(code);
  return null;
}
