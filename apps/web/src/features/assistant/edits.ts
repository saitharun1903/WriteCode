/**
 * Edit blocks from the assistant: parsing, and locating them in the user's
 * files. An edit names the exact current lines (ORIGINAL) and their
 * replacement (UPDATED); applying it replaces just those lines, never the
 * cursor position.
 *
 *   ```edit
 *   FILE: Candies.java
 *   <<<<<<< ORIGINAL
 *                   high = mid -
 *   =======
 *                   high = mid - 1;
 *   >>>>>>> UPDATED
 *   ```
 *
 * An edit with nothing in ORIGINAL makes its file when the project has none of
 * that name, fills the file when it is empty, and otherwise adds its lines at
 * the end.
 */

export interface EditHunk {
  original: string[];
  updated: string[];
}

export interface EditBlock {
  file: string;
  hunks: EditHunk[];
  /** False while the block is still streaming in. */
  complete: boolean;
}

const START = /^<{5,}\s*ORIGINAL\s*$/;
const MIDDLE = /^={5,}\s*$/;
const END = /^>{5,}\s*UPDATED\s*$/;

/**
 * Parses the body of an ```edit block. Returns null when it has no FILE line yet.
 * `final`: the answer has ended, so what a model sometimes leaves out is filled
 * in: the end mark of the last pair, the ORIGINAL mark of a pair with nothing to
 * replace, or the marks altogether (the lines after FILE are then new lines).
 */
export function parseEditBlock(body: string, final = false): EditBlock | null {
  const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const fileLine = lines.findIndex((l) => /^FILE:\s*\S/.test(l.trim()));
  if (fileLine < 0) return null;
  const file = lines[fileLine]!.trim().replace(/^FILE:\s*/, "").replace(/^`|`$/g, "").replace(/^\.?\//, "");
  const hunks: EditHunk[] = [];
  let state: "none" | "original" | "updated" = "none";
  let current: EditHunk = { original: [], updated: [] };
  /** Lines outside any pair. */
  const loose: string[] = [];
  for (const line of lines.slice(fileLine + 1)) {
    if (START.test(line.trim())) {
      state = "original";
      current = { original: [], updated: [] };
    } else if (MIDDLE.test(line.trim()) && state !== "updated") {
      // Without an ORIGINAL mark before it, there is nothing to replace.
      if (state === "none") current = { original: [], updated: [] };
      state = "updated";
    } else if (END.test(line.trim()) && state === "updated") {
      hunks.push(current);
      state = "none";
    } else if (state === "original") {
      current.original.push(line);
    } else if (state === "updated") {
      current.updated.push(line);
    } else loose.push(line);
  }
  if (final && state === "updated") {
    hunks.push(current);
    state = "none";
  }
  if (final && state === "none" && hunks.length === 0 && loose.some((l) => l.trim())) {
    while (loose.length && !loose[0]!.trim()) loose.shift();
    while (loose.length && !loose[loose.length - 1]!.trim()) loose.pop();
    hunks.push({ original: [], updated: loose });
  }
  return { file, hunks, complete: state === "none" && hunks.length > 0 };
}

export interface ResolvedHunk {
  /** 1-based first line replaced in the file as it was before this hunk; for inserts into a new file, 1. */
  startLine: number;
  removed: string[];
  added: string[];
}

export type Resolution =
  | { ok: true; content: string; hunks: ResolvedHunk[]; created: boolean }
  | { ok: false; reason: string };

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];
const firstCode = (lines: string[]) => lines.find((l) => l.trim()) ?? "";

/** Finds `needle` as a run of whole lines in `hay`. Exact first, then ignoring indentation and trailing spaces. */
function locate(hay: string[], needle: string[]): { index: number; exact: boolean } | { error: string } {
  const find = (eq: (a: string, b: string) => boolean) => {
    const hits: number[] = [];
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((n, k) => eq(hay[i + k]!, n))) hits.push(i);
    }
    return hits;
  };
  const exact = find((a, b) => a.trimEnd() === b.trimEnd());
  if (exact.length === 1) return { index: exact[0]!, exact: true };
  if (exact.length > 1) return { error: "the lines to change appear more than once" };
  const loose = find((a, b) => a.trim() === b.trim());
  if (loose.length === 1) return { index: loose[0]!, exact: false };
  if (loose.length > 1) return { error: "the lines to change appear more than once" };
  return { error: "the file no longer contains the lines this fix changes" };
}

/**
 * Applies an edit block to a file's current content. `content` is null when
 * the file does not exist (the edit may create it). Hunks apply in order.
 */
export function resolveEdit(content: string | null, block: EditBlock): Resolution {
  if (!block.complete || block.hunks.length === 0) return { ok: false, reason: "the fix is incomplete" };
  if (content === null) {
    if (block.hunks.length === 1 && block.hunks[0]!.original.every((l) => !l.trim())) {
      const added = block.hunks[0]!.updated;
      return { ok: true, content: added.join("\n") + "\n", hunks: [{ startLine: 1, removed: [], added }], created: true };
    }
    return { ok: false, reason: `${block.file} is not in the project` };
  }

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let trailing = /\r?\n$/.test(content);
  let lines = content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const hunks: ResolvedHunk[] = [];
  for (const hunk of block.hunks) {
    // Blank lines around the quoted code are not significant.
    const original = [...hunk.original];
    while (original.length && !original[0]!.trim()) original.shift();
    while (original.length && !original[original.length - 1]!.trim()) original.pop();
    if (original.length === 0) {
      if (hunk.updated.every((l) => !l.trim())) return { ok: false, reason: "the fix does not say which lines to change" };
      if (lines.every((l) => !l.trim())) {
        // An empty file: the new lines are its content.
        hunks.push({ startLine: 1, removed: [], added: hunk.updated });
        lines = [...hunk.updated];
        trailing = true;
      } else {
        // Nothing to replace: the new lines go at the end, a blank line after what is there.
        const added = lines[lines.length - 1]!.trim() ? ["", ...hunk.updated] : hunk.updated;
        hunks.push({ startLine: lines.length + 1, removed: [], added });
        lines = [...lines, ...added];
      }
      continue;
    }
    const found = locate(lines, original);
    if ("error" in found) return { ok: false, reason: found.error };

    const removed = lines.slice(found.index, found.index + original.length);
    let added = hunk.updated;
    if (!found.exact) {
      const indents = (ls: string[]) => new Set(ls.filter((l) => l.trim()).map(indentOf)).size;
      if (indents(original) <= 1 && indents(removed) > 1) {
        // The model flattened the indentation: give each line the indentation of the file line it
        // corresponds to (same text, else same position).
        added = added.map((l, i) => {
          if (!l.trim()) return l;
          const same = original.findIndex((o) => o.trim() === l.trim());
          return indentOf(removed[same >= 0 ? same : Math.min(i, removed.length - 1)]!) + l.trimStart();
        });
      } else {
        // The model's indentation was shifted: shift the replacement by the same amount.
        const fileIndent = indentOf(firstCode(removed));
        const quotedIndent = indentOf(firstCode(original));
        added = added.map((l) => {
          if (!l.trim()) return l;
          return l.startsWith(quotedIndent) ? fileIndent + l.slice(quotedIndent.length) : fileIndent + l.trimStart();
        });
      }
    }
    hunks.push({ startLine: found.index + 1, removed, added });
    lines = [...lines.slice(0, found.index), ...added, ...lines.slice(found.index + original.length)];
  }
  return { ok: true, content: lines.join(eol) + (trailing ? eol : ""), hunks, created: false };
}
