import type { SourceFile } from "../execution/types.js";
import { getLanguage } from "../languages/registry.js";

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
export function scanJava(source: string): { packageName: string | null; mains: JavaMain[]; types: string[] } {
  const masked = maskSource(source, "c");
  const tokens: { t: string; at: number }[] = [];
  for (const m of masked.matchAll(/[A-Za-z_$][\w$]*|\.\.\.|\S/g)) tokens.push({ t: m[0], at: m.index });

  let packageName: string | null = null;
  const mains: JavaMain[] = [];
  /** Types declared at the top of the file (not inside another type). */
  const types: string[] = [];
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
      if (pendingType && scopes.length === 0) types.push(pendingType.name);
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
  return { packageName, mains, types };
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

/**
 * The class the JVM starts for a Kotlin file with a top-level `main`: the
 * file's name with a capital first letter and `Kt` after it (`Main.kt` is
 * `MainKt`), in the file's package.
 */
export function kotlinMainClass(file: SourceFile): string {
  const pkg = /^[ \t]*package[ \t]+([\w.]+)/m.exec(maskSource(file.content, "c"))?.[1];
  const stem = stripExtension(basename(file.path)).replace(/[^A-Za-z0-9_$]/g, "_");
  const name = `${stem.charAt(0).toUpperCase()}${stem.slice(1)}Kt`;
  return pkg ? `${pkg}.${name}` : name;
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

function cMainLine(source: string, pattern?: string): number | null {
  const masked = maskSource(source, "c");
  if (pattern) {
    const m = new RegExp(pattern, "m").exec(masked);
    return m ? lineAt(source, m.index + (m[0].length - m[0].trimStart().length)) : null;
  }
  let depth = 0;
  for (const m of masked.matchAll(/[{}]|\bint\s+main\s*\(/g)) {
    if (m[0] === "{") depth++;
    else if (m[0] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) return lineAt(source, m.index);
  }
  return null;
}

/** The files of a language the compiler (or, with none, the runtime) takes as programs. */
function isSource(language: string, path: string): boolean {
  const lang = getLanguage(language);
  const lower = path.toLowerCase();
  return !!lang && (lang.compiler?.sourceExtensions ?? lang.extensions).some((ext) => lower.endsWith(ext));
}

/**
 * Entry points in a project, in path order, found the way the language marks
 * them: every launchable main class, files defining `int main(`, or files with
 * a `__main__` guard. Languages with no marker list none.
 */
export function findEntryPoints(language: string, files: readonly SourceFile[]): EntryPoint[] {
  const lang = getLanguage(language);
  const style = lang?.entryPoints;
  if (!style) return [];
  const out: EntryPoint[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    if (!isSource(language, f.path)) continue;
    if (style === "class-main") {
      const { packageName, mains } = scanJava(f.content);
      for (const m of mains) {
        const mainClass = packageName ? `${packageName}.${m.binaryName}` : m.binaryName;
        out.push({ file: f.path, line: m.line, label: mainClass.replaceAll("$", "."), mainClass });
      }
    } else {
      const line = style === "function-main" ? cMainLine(f.content, lang?.entryPattern) : pythonGuardLine(f.content);
      if (line) out.push({ file: f.path, line, label: f.path });
    }
  }
  return out;
}

/** True when any file of this language can be run directly (nothing is compiled first). */
export function anyFileIsRunnable(language: string): boolean {
  const lang = getLanguage(language);
  return !!lang && !lang.compiler;
}

/** True when `file` is a program of its own: a source file of the language that has a place to start from. */
export function canRunFile(language: string, file: SourceFile): boolean {
  if (!isSource(language, file.path)) return false;
  return anyFileIsRunnable(language) || findEntryPoints(language, [file]).length > 0;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** `a/b/../c` and `./c` as plain project paths; undefined when it leaves the project. */
function resolvePath(base: string, relative: string): string | undefined {
  const parts = base ? base.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/**
 * The files of the project that the program starting in `entry` loads,
 * directly or through the files it loads, read from the language's import
 * statements. A module is matched by its path with or without the file's
 * extension, from the importing file's folder or the project's.
 */
export function modulesUsed(language: string, entry: string, files: readonly SourceFile[]): string[] {
  const patterns = (getLanguage(language)?.imports ?? []).map((p) => new RegExp(p, "gm"));
  const start = files.find((f) => f.path === entry);
  if (!patterns.length || !start) return [];
  const byStem = new Map<string, SourceFile>();
  for (const f of files) {
    if (!isSource(language, f.path)) continue;
    const stem = f.path.slice(0, f.path.lastIndexOf("."));
    for (const key of [f.path, stem, ...(/(^|\/)(__init__|index)$/.test(stem) ? [dirOf(stem)] : [])]) if (!byStem.has(key)) byStem.set(key, f);
  }
  const seen = new Set([start.path]);
  const queue = [start];
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const pattern of patterns) {
      for (const m of file.content.matchAll(pattern)) {
        for (const item of (m[1] ?? "").split(",")) {
          const spec = item.trim().split(/\s+/)[0] ?? "";
          if (!spec) continue;
          // `pkg.mod` and `.mod` name files by dots where there is no path in the name.
          const dotted = spec.includes("/") ? spec : spec.replace(/^\.+/, "").replaceAll(".", "/");
          for (const candidate of new Set([spec, dotted])) {
            for (const base of new Set([dirOf(file.path), ""])) {
              const path = resolvePath(base, candidate);
              const used = path === undefined ? undefined : byStem.get(path);
              if (used && !seen.has(used.path)) {
                seen.add(used.path);
                queue.push(used);
              }
            }
          }
        }
      }
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}

/**
 * What Run starts: the file in the editor when it is a program of its own
 * (not a module the entry program loads), otherwise the project's entry file, or the one file with a main function
 * when the entry file has none. `choices` lists the candidates when the
 * program to run cannot be told (several files with a main function, none of
 * them the entry file or the open one).
 */
export function runTarget(project: { language: string; entryFile: string; files: readonly SourceFile[] }, activeFile?: string | null): { entry: string; choices?: string[] } {
  const active = activeFile ? project.files.find((f) => f.path === activeFile) : undefined;
  if (active && canRunFile(project.language, active)) {
    // A file the entry program loads, with no start of its own, is a part of that program, not another one.
    const part =
      active.path !== project.entryFile &&
      anyFileIsRunnable(project.language) &&
      findEntryPoints(project.language, [active]).length === 0 &&
      modulesUsed(project.language, project.entryFile, project.files).includes(active.path);
    return { entry: part ? project.entryFile : active.path };
  }
  if (anyFileIsRunnable(project.language)) return { entry: project.entryFile };
  const mains = [...new Set(findEntryPoints(project.language, project.files).map((e) => e.file))];
  if (!mains.length || mains.includes(project.entryFile)) return { entry: project.entryFile };
  return mains.length === 1 ? { entry: mains[0]! } : { entry: project.entryFile, choices: mains };
}

/**
 * For languages built class by class: the other files of the project that the
 * program in `entry` uses, directly or through the files it uses. A file is
 * used when a type it declares is named in the code (comments and strings do
 * not count). Naming the files leaves nothing to how the folders are laid out
 * or to a type kept in a file with another name.
 */
export function classFilesUsed(language: string, entry: string, files: readonly SourceFile[]): string[] {
  if (getLanguage(language)?.entryPoints !== "class-main") return [];
  const sources = files.filter((f) => isSource(language, f.path));
  const start = sources.find((f) => f.path === entry);
  if (!start) return [];
  const declaredIn = new Map<string, SourceFile[]>();
  for (const f of sources) {
    for (const type of scanJava(f.content).types) declaredIn.set(type, [...(declaredIn.get(type) ?? []), f]);
  }
  const seen = new Set([start.path]);
  const queue = [start];
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const m of maskSource(file.content, "c").matchAll(/[A-Za-z_$][\w$]*/g)) {
      for (const used of declaredIn.get(m[0]) ?? []) {
        if (seen.has(used.path)) continue;
        seen.add(used.path);
        queue.push(used);
      }
    }
  }
  seen.delete(entry);
  return [...seen].sort();
}
