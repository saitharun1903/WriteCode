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

/**
 * Extracts navigable diagnostics from compiler output or program stderr.
 * `knownFiles` are project paths; diagnostics outside the project are dropped.
 */
export function parseDiagnostics(languageId: string, text: string, knownFiles: Iterable<string>): Diagnostic[] {
  if (!text) return [];
  const files = new Set(knownFiles);
  switch (languageId) {
    case "c":
    case "cpp":
      return parseGcc(text, files);
    case "java":
      return [...parseJavac(text, files), ...parseJvmTrace(text, files)];
    case "python":
      return parsePython(text, files);
    case "javascript":
    case "typescript":
      return parseNode(text, files);
    default:
      return [];
  }
}
