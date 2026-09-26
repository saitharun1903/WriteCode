import type { SourceFile } from "../execution/types.js";

/** A place a program can start from. */
export interface EntryPoint {
  /** Project file that contains the entry point. */
  file: string;
  /** 1-based line of the `main` declaration (or `if __name__` guard). */
  line: number;
  /** What the user sees, e.g. `com.app.Main` or `main.py`. */
  label: string;
  /** Java only: binary class name passed to the `java` launcher, e.g. `com.app.Outer$Inner`. */
  mainClass?: string;
}

type Syntax = "c" | "python";

/**
 * Replaces comments with spaces and the contents of string/char literals with
 * spaces, keeping quotes, line breaks and offsets. Lets the scanners below
 * ignore `main` inside comments and strings.
 */
export function maskSource(src: string, syntax: Syntax): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (syntax === "c" && two === "//") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (syntax === "c" && two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (syntax === "python" && c === "#") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (three === '"""' || (syntax === "python" && three === "'''")) {
      // Java text blocks and Python triple-quoted strings.
      const end = src.indexOf(three, i + 3);
      const stop = end === -1 ? src.length : end + 3;
      blank(i + 3, stop - 3);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset; k++) if (src.charCodeAt(k) === 10) line++;
  return line;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

const TYPE_KEYWORDS = new Set(["class", "interface", "enum", "record"]);

interface JavaMain {
  line: number;
  /** Binary name without the package, e.g. `Outer$Inner`. */
  binaryName: string;
}

/**
 * Finds `public static void main(String[] args)` methods declared directly in
 * a class, interface, enum or record, and the file's package.
 */
export function scanJava(source: string): { packageName: string | null; mains: JavaMain[] } {
  const masked = maskSource(source, "c");
  const tokens: { t: string; at: number }[] = [];
  for (const m of masked.matchAll(/[A-Za-z_$][\w$]*|\.\.\.|\S/g)) tokens.push({ t: m[0], at: m.index });

  let packageName: string | null = null;
  const mains: JavaMain[] = [];
  const scopes: { kind: "type" | "block"; name?: string; typeKind?: string }[] = [];
  let pendingType: { name: string; kind: string } | null = null;

  for (let k = 0; k < tokens.length; k++) {
    const { t } = tokens[k]!;
    const prev = tokens[k - 1]?.t;
    if (t === "package" && scopes.length === 0 && packageName === null) {
      const parts: string[] = [];
      let j = k + 1;
      while (j < tokens.length && tokens[j]!.t !== ";") parts.push(tokens[j++]!.t);
      packageName = parts.join("");
      k = j;
      continue;
    }
    if (TYPE_KEYWORDS.has(t) && prev !== "." && prev !== "@" && /^[A-Za-z_$]/.test(tokens[k + 1]?.t ?? "")) {
      // `record` and `enum` can also be identifiers; a type declaration is followed by a name and, later, a body.
      pendingType = { name: tokens[k + 1]!.t, kind: t };
      k++;
      continue;
    }
    if (t === "{") {
      scopes.push(pendingType ? { kind: "type", name: pendingType.name, typeKind: pendingType.kind } : { kind: "block" });
      pendingType = null;
      continue;
    }
    if (t === "}") {
      scopes.pop();
      continue;
    }
    if (t === ";" && pendingType && scopes.length > 0) {
      pendingType = null;
      continue;
    }
    const owner = scopes[scopes.length - 1];
    if (t !== "main" || prev !== "void" || tokens[k + 1]?.t !== "(" || owner?.kind !== "type") continue;

    // Parameters: [final] (String | java.lang.String) ( [] name | ... name | name [] )
    const params: string[] = [];
    let j = k + 2;
    while (j < tokens.length && tokens[j]!.t !== ")") params.push(tokens[j++]!.t);
    const p = params.filter((x) => x !== "final").join(" ").replace(/java \. lang \. /, "");
    if (!/^String (\[ \] [\w$]+|\.\.\. [\w$]+|[\w$]+ \[ \])$/.test(p)) continue;

    // Modifiers before `void`, back to the previous declaration boundary.
    const modifiers = new Set<string>();
    for (let b = k - 2; b >= 0 && !["{", "}", ";"].includes(tokens[b]!.t); b--) modifiers.add(tokens[b]!.t);
    const implicitPublic = owner.typeKind === "interface";
    if (!modifiers.has("static") || (!modifiers.has("public") && !implicitPublic) || modifiers.has("private") || modifiers.has("protected")) continue;

    const names = scopes.filter((s) => s.kind === "type").map((s) => s.name!);
    // Only types nested directly in types (not local or anonymous classes) are launchable.
    if (scopes.some((s) => s.kind === "block")) continue;
    mains.push({ line: lineAt(source, tokens[k]!.at), binaryName: names.join("$") });
  }
  return { packageName, mains };
}

/**
 * Binary name of the class to launch for a Java entry file: the class with a
 * main method named after the file, else the first one found, else the
 * file's name (so the launcher reports the real error).
 */
export function javaMainClass(file: SourceFile): string {
  const { packageName, mains } = scanJava(file.content);
  const fileClass = stripExtension(basename(file.path));
  const chosen = mains.find((m) => m.binaryName === fileClass) ?? mains[0];
  const name = chosen?.binaryName ?? fileClass;
  return packageName ? `${packageName}.${name}` : name;
}

const PY_MAIN_GUARD = /^if\s+__name__\s*==\s*(["'])__main__\1\s*:/;

function pythonGuardLine(source: string): number | null {
  const masked = maskSource(source, "python").split("\n");
  const lines = source.split("\n");
  for (let k = 0; k < lines.length; k++) {
    if (PY_MAIN_GUARD.test(lines[k]!) && /^if\s+__name__/.test(masked[k]!)) return k + 1;
  }
  return null;
}

function cMainLine(source: string): number | null {
  const masked = maskSource(source, "c");
  let depth = 0;
  for (const m of masked.matchAll(/[{}]|\bint\s+main\s*\(/g)) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) return lineAt(source, m.index);
  }
  return null;
}

/**
 * Entry points in a project, in path order. Java: every launchable main
 * class. C/C++: files defining `int main(`. Python: files with a
 * `__main__` guard. JavaScript/TypeScript have no marker, so none are listed.
 */
export function findEntryPoints(language: string, files: readonly SourceFile[]): EntryPoint[] {
  const out: EntryPoint[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    const lower = f.path.toLowerCase();
    if (language === "java" && lower.endsWith(".java")) {
      const { packageName, mains } = scanJava(f.content);
      for (const m of mains) {
        const mainClass = packageName ? `${packageName}.${m.binaryName}` : m.binaryName;
        out.push({ file: f.path, line: m.line, label: mainClass.replaceAll("$", "."), mainClass });
      }
    } else if ((language === "c" || language === "cpp") && /\.(c|cc|cpp|cxx)$/.test(lower)) {
      const line = cMainLine(f.content);
      if (line) out.push({ file: f.path, line, label: f.path });
    } else if (language === "python" && lower.endsWith(".py")) {
      const line = pythonGuardLine(f.content);
      if (line) out.push({ file: f.path, line, label: f.path });
    }
  }
  return out;
}

/** True when any file of this language can be run directly (interpreted languages). */
export function anyFileIsRunnable(language: string): boolean {
  return language === "python" || language === "javascript" || language === "typescript";
}
