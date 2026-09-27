/**
 * Values shown at the end of source lines while paused, as in IntelliJ: each
 * variable of the paused frame appears on the last line at or above the
 * paused line (within the current function) that mentions it.
 */

export interface InlineVar {
  name: string;
  value: string;
  /** Changed since the previous pause in this frame. */
  changed: boolean;
}

// A function header: Python `def`, or a Java/C/C++/JS/TS signature ending in `{` (not if/for/while/...).
const PY_DEF = /^\s*(async\s+)?def\s+\w+\s*\(/;
const C_LIKE_HEADER = /^\s*(?!(if|for|while|switch|catch|else|do|try|return|new)\b)[\w<>[\],.?*&\s]+\s+[\w$]+\s*\([^;]*\)\s*(throws\s+[\w.,\s]+)?\s*\{?\s*$/;
const JS_FUNCTION = /\bfunction\b|=>\s*\{?\s*$/;

function isFunctionHeader(line: string): boolean {
  return PY_DEF.test(line) || C_LIKE_HEADER.test(line) || JS_FUNCTION.test(line);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Shortens a value for display next to code. */
export function shortValue(value: string, max = 36): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Lines (1-based) mapped to the variables to show on them. `lines` is the
 * file's source; `current` the paused line.
 */
export function inlineValues(lines: string[], current: number, vars: InlineVar[]): Map<number, InlineVar[]> {
  const out = new Map<number, InlineVar[]>();
  if (current < 1 || current > lines.length) return out;
  let start = Math.max(1, current - 120);
  for (let l = current; l >= start; l--) {
    if (isFunctionHeader(lines[l - 1]!)) {
      start = l;
      break;
    }
  }
  for (const v of vars) {
    if (!/^[A-Za-z_$][\w$]*$/.test(v.name)) continue;
    const word = new RegExp(`(^|[^\\w$.])${escape(v.name)}(?![\\w$])`);
    for (let l = current; l >= start; l--) {
      // Ignore mentions inside comments.
      const code = lines[l - 1]!.replace(/(\/\/|#).*$/, "");
      if (word.test(code)) {
        out.set(l, [...(out.get(l) ?? []), v]);
        break;
      }
    }
  }
  return out;
}

/**
 * A one-line preview of a collection from its loaded children: `[5, 2, 9]` for
 * arrays and lists (children named `[0]`, `[1]`...), `{ann: 30}` otherwise; null when empty.
 */
export function previewOf(children: { name: string; value: string }[], max = 8): string | null {
  // Empty: the value's own text (e.g. "String[0]") says more than "[]" or "{}" would.
  if (children.length === 0) return null;
  // Lists show their elements only, not implementation fields such as elementData or modCount.
  const indexed = children.filter((c) => /^\[\d+\]$/.test(c.name));
  const items = indexed.length > 0 ? indexed : children;
  const shown = items.slice(0, max);
  const more = items.length > max ? ", …" : "";
  if (indexed.length > 0) return `[${shown.map((c) => shortValue(c.value, 20)).join(", ")}${more}]`;
  return `{${shown.map((c) => `${c.name}: ${shortValue(c.value, 20)}`).join(", ")}${more}}`;
}
