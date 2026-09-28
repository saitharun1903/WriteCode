/**
 * Finds references to project files in program and compiler output, so the
 * console can link them to the editor:
 *
 * - `Main.java:5: error:` and `at Main.main(Main.java:5)` (javac, Java stack traces)
 * - `File "/workspace/main.py", line 3` (Python tracebacks)
 * - `main.cpp:5:10: error:` (gcc and g++)
 * - `at f (/workspace/main.js:3:5)` (Node.js stack traces)
 *
 * Only files that exist in the project are linked, so library frames such as
 * `Integer.java:614` stay plain text.
 */
export type Segment = { text: string } | { text: string; file: string; line: number; column?: number };

const SANDBOX = /^\/?workspace\//;
const EXT = "java|py|cpp|cc|cxx|hpp|h|c|js|mjs|cjs|ts|mts";
const PATTERN = new RegExp(
  // Python: File "path", line N
  `File "([^"\\n]+)", line (\\d+)` +
    // Everything else: path:line[:column], the path made of path characters and ending in a source extension.
    `|((?:/?workspace/)?[A-Za-z0-9_./-]*[A-Za-z0-9_-]\\.(?:${EXT})):(\\d+)(?::(\\d+))?`,
  "g",
);

/** Maps a path as printed by a tool to a project file: exact, else the only file with that name. */
export function resolveFile(printed: string, files: readonly string[]): string | null {
  const path = printed.replace(SANDBOX, "").replace(/^\.\//, "");
  if (files.includes(path)) return path;
  const name = path.split("/").pop()!;
  const matches = files.filter((f) => f === name || f.endsWith(`/${path}`) || f.split("/").pop() === name);
  return matches.length === 1 ? matches[0]! : null;
}

export function linkSources(text: string, files: readonly string[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of text.matchAll(PATTERN)) {
    const printed = m[1] ?? m[3]!;
    const line = Number(m[2] ?? m[4]);
    const column = m[5] ? Number(m[5]) : undefined;
    const file = resolveFile(printed, files);
    if (!file || !line) continue;
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], file, line, ...(column ? { column } : {}) });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
