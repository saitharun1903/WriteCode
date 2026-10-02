import { getLanguage } from "../languages/registry.js";
import type { DiagnosticFormat } from "../languages/types.js";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column, when the tool reports one. */
  column?: number;
  severity: DiagnosticSeverity;
  message: string;
  source: "compiler" | "runtime";
}

/** Directory the sandbox mounts project files into. Paths are reported relative to it. */
export const SANDBOX_WORKDIR = "/workspace";

function normalizePath(raw: string, knownFiles: ReadonlySet<string>): string | undefined {
  let p = raw.trim().replaceAll("\\", "/");
  if (p.startsWith(SANDBOX_WORKDIR + "/")) p = p.slice(SANDBOX_WORKDIR.length + 1);
  if (p.startsWith("./")) p = p.slice(2);
  if (knownFiles.has(p)) return p;
  // javac and JVM stack traces report bare file names; match by basename when unambiguous.
  const matches = [...knownFiles].filter((f) => f === p || f.endsWith("/" + p));
  return matches.length === 1 ? matches[0] : undefined;
}

function severityOf(word: string): DiagnosticSeverity {
  if (word.includes("warning")) return "warning";
  if (word.includes("note")) return "info";
  return "error";
}

/** GCC / Clang: `main.cpp:3:5: error: expected ';'` */
function parseGcc(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const file = normalizePath(m[1]!, files);
    if (!file) continue;
    out.push({
      file,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: severityOf(m[4]!),
      message: m[5]!.trim(),
      source: "compiler",
    });
  }
  return out;
}

/** javac: `Main.java:14: error: ';' expected`, followed by the source line and a caret line. */
function parseJavac(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lines = text.split("\n");
  const re = /^(.+?\.java):(\d+): (error|warning): (.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!);
    if (!m) continue;
    const file = normalizePath(m[1]!, files);
    if (!file) continue;
    let column: number | undefined;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const caret = lines[j]!.replace(/\r$/, "");
      if (/^\s*\^\s*$/.test(caret)) {
        column = caret.indexOf("^") + 1;
        break;
      }
    }
    out.push({
      file,
      line: Number(m[2]),
      column,
      severity: severityOf(m[3]!),
      message: m[4]!.trim(),
      source: "compiler",
    });
  }
  return out;
}

/** CPython tracebacks and syntax errors. Reports the innermost frame inside the project. */
function parsePython(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const frameRe = /^\s*File "(.+?)", line (\d+)/;
  let last: { file: string; line: number } | undefined;
  for (const l of lines) {
    const m = frameRe.exec(l);
    if (!m) continue;
    const file = normalizePath(m[1]!, files);
    if (file) last = { file, line: Number(m[2]) };
  }
  if (!last) return [];
  const message = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Interrupt|Exit)\b/.test(l));
  const isSyntax = message ? /^(SyntaxError|IndentationError|TabError)\b/.test(message) : false;
  return [
    {
      file: last.file,
      line: last.line,
      severity: "error",
      message: message?.trim() ?? "Uncaught exception",
      source: isSyntax ? "compiler" : "runtime",
    },
  ];
}

/** JVM stack traces: `at Main.main(Main.java:5)` preceded by `Exception in thread ...`. */
function parseJvmTrace(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const header = lines.find((l) => /^Exception in thread|^[\w.$]+(Exception|Error)\b/.test(l));
  const frameRe = /^\s*at .+\((.+?\.java):(\d+)\)/;
  for (const l of lines) {
    const m = frameRe.exec(l);
    if (!m) continue;
    const file = normalizePath(m[1]!, files);
    if (!file) continue;
    return [{ file, line: Number(m[2]), severity: "error", message: header?.trim() ?? "Uncaught exception", source: "runtime" }];
  }
  return [];
}

/** Node.js: first `at ... (/workspace/main.js:3:9)` frame, or the `file:line` header of a SyntaxError. */
function parseNode(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const message = lines.find((l) => /^\w*(Error|Exception)\b/.test(l))?.trim() ?? "Uncaught exception";
  const frameRe = /\(?((?:file:\/\/)?[^\s()]+?):(\d+):(\d+)\)?\s*$/;
  for (const l of lines) {
    if (!/^\s*at /.test(l)) continue;
    const m = frameRe.exec(l);
    if (!m) continue;
    const file = normalizePath(m[1]!.replace(/^file:\/\//, ""), files);
    if (file) return [{ file, line: Number(m[2]), column: Number(m[3]), severity: "error", message, source: "runtime" }];
  }
  const header = /^(.+?):(\d+)$/.exec(lines[0] ?? "");
  if (header) {
    const file = normalizePath(header[1]!.replace(/^file:\/\//, ""), files);
    if (file) return [{ file, line: Number(header[2]), severity: "error", message, source: "compiler" }];
  }
  return [];
}

const linesOf = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, ""));

/** Go: `./main.go:7:14: undefined: y` from the compiler; a panic's first frame in the project when it crashes. */
function parseGo(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const lines = linesOf(text);
  const out: Diagnostic[] = [];
  for (const l of lines) {
    const m = /^(.+?\.go):(\d+):(\d+): (.*)$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    if (m && file) out.push({ file, line: Number(m[2]), column: Number(m[3]), severity: "error", message: m[4]!.trim(), source: "compiler" });
  }
  if (out.length) return out;
  const panic = lines.find((l) => /^(panic|fatal error): /.test(l));
  if (!panic) return [];
  for (const l of lines) {
    const m = /^\s+(.+?\.go):(\d+)(?: \+0x[0-9a-f]+)?$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    if (m && file) return [{ file, line: Number(m[2]), severity: "error", message: panic.trim(), source: "runtime" }];
  }
  return [];
}

/** rustc: `error[E0308]: mismatched types`, then ` --> main.rs:1:26`; a panic names its place itself. */
function parseRustc(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const lines = linesOf(text);
  const out: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(error|warning)(?:\[\w+\])?: (.*)$/.exec(lines[i]!);
    if (head) {
      const at = /^\s*--> (.+?):(\d+):(\d+)$/.exec(lines[i + 1] ?? "");
      const file = at && normalizePath(at[1]!, files);
      if (at && file) out.push({ file, line: Number(at[2]), column: Number(at[3]), severity: severityOf(head[1]!), message: head[2]!.trim(), source: "compiler" });
      continue;
    }
    const panic = /^thread '.*?' panicked at (.+?):(\d+):(\d+):$/.exec(lines[i]!);
    const file = panic && normalizePath(panic[1]!, files);
    if (panic && file) out.push({ file, line: Number(panic[2]), column: Number(panic[3]), severity: "error", message: (lines[i + 1] ?? "").trim() || "The program panicked", source: "runtime" });
  }
  return out;
}

/** The C# compiler: `Program.cs(5,13): error CS1002: ; expected`. */
function parseCsc(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of linesOf(text)) {
    const m = /^(.+?\.cs)\((\d+),(\d+)\): (error|warning) (\w+): (.*)$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    if (m && file) out.push({ file, line: Number(m[2]), column: Number(m[3]), severity: severityOf(m[4]!), message: `${m[6]!.trim()} (${m[5]})`, source: "compiler" });
  }
  return out;
}

/** .NET: `Unhandled exception. System.X: message`, then `at Program.Main() in /workspace/Program.cs:line 5`. */
function parseDotnetTrace(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const lines = linesOf(text);
  const header = lines.find((l) => l.startsWith("Unhandled exception. "));
  if (!header) return [];
  for (const l of lines) {
    const m = /^\s*at .+ in (.+?):line (\d+)$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    if (m && file) return [{ file, line: Number(m[2]), severity: "error", message: header.slice("Unhandled exception. ".length).trim(), source: "runtime" }];
  }
  return [];
}

/** PHP: `Parse error: ... in /workspace/main.php on line 3`, `Fatal error: Uncaught Exception: boom in /workspace/main.php:2`. */
function parsePhp(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of linesOf(text)) {
    const m = /^(?:PHP )?(Parse error|Fatal error|Warning|Notice|Deprecated): (.*?) in (.+?\.php)(?: on line |:)(\d+)$/.exec(l);
    const file = m && normalizePath(m[3]!, files);
    if (!m || !file) continue;
    const kind = m[1]!;
    out.push({ file, line: Number(m[4]), severity: kind.endsWith("error") ? "error" : "warning", message: m[2]!.trim(), source: kind === "Parse error" ? "compiler" : "runtime" });
  }
  return out;
}

/** Ruby: `main.rb:2:in 'Object#f': boom (RuntimeError)`, `main.rb:2: syntax error found (SyntaxError)`. */
function parseRuby(text: string, files: ReadonlySet<string>): Diagnostic[] {
  for (const l of linesOf(text)) {
    const m = /^(.+?\.rb):(\d+):(?:in [`'].*?': ?)?\s*(.+)$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    if (m && file) return [{ file, line: Number(m[2]), severity: "error", message: m[3]!.trim(), source: /\(SyntaxError\)$|syntax error/.test(m[3]!) ? "compiler" : "runtime" }];
  }
  return [];
}

/** Bash: `main.sh: line 3: foo: command not found`. */
function parseBash(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of linesOf(text)) {
    const m = /^(.+?): line (\d+): (.*)$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    // A syntax error is reported twice: the second line only quotes the code.
    if (m && file && !/^`.*'$/.test(m[3]!)) out.push({ file, line: Number(m[2]), severity: "error", message: m[3]!.trim(), source: /syntax error/.test(m[3]!) ? "compiler" : "runtime" });
  }
  return out;
}

/** `main.sql:3: error: no such table: t` */
function parsePlain(text: string, files: ReadonlySet<string>): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const l of linesOf(text)) {
    const m = /^(.+?):(\d+): (error|warning): (.*)$/.exec(l);
    const file = m && normalizePath(m[1]!, files);
    if (m && file) out.push({ file, line: Number(m[2]), severity: severityOf(m[3]!), message: m[4]!.trim(), source: "runtime" });
  }
  return out;
}

const PARSERS: Record<DiagnosticFormat, (text: string, files: ReadonlySet<string>) => Diagnostic[]> = {
  gcc: parseGcc,
  javac: parseJavac,
  "jvm-trace": parseJvmTrace,
  python: parsePython,
  node: parseNode,
  go: parseGo,
  rustc: parseRustc,
  csc: parseCsc,
  "dotnet-trace": parseDotnetTrace,
  php: parsePhp,
  ruby: parseRuby,
  bash: parseBash,
  plain: parsePlain,
};

/**
 * Extracts navigable diagnostics from compiler output or program stderr.
 * `knownFiles` are project paths; diagnostics outside the project are dropped.
 */
export function parseDiagnostics(languageId: string, text: string, knownFiles: Iterable<string>): Diagnostic[] {
  if (!text) return [];
  const files = new Set(knownFiles);
  return (getLanguage(languageId)?.diagnostics ?? []).flatMap((format) => PARSERS[format](text, files));
}
