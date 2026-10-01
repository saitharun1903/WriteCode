/**
 * A small syntax colourer for the languages the IDE runs. It is used where the
 * editor itself is not loaded: the PDF of a project and the page of a shared
 * link. It marks comments, strings, numbers and keywords, which is what makes
 * code readable at a glance; it does not try to understand the program.
 */

import { LANGUAGES, getLanguage } from "@cw/shared";

export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Rules {
  line: string[];
  block?: [string, string];
  /** Quotes that may span lines. */
  multiline: string[];
  quotes: string[];
  keywords: Set<string>;
  /** `#include` and friends are coloured as keywords. */
  preprocessor?: boolean;
}

const words = (s: string) => new Set(s.split(" "));

const C_LIKE = "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while";
const JS = "async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield";

const RULES: Record<string, Rules> = {
  python: {
    line: ["#"],
    multiline: ['"""', "'''"],
    quotes: ['"', "'"],
    keywords: words("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print range len self"),
  },
  java: {
    line: ["//"],
    block: ["/*", "*/"],
    multiline: ['"""'],
    quotes: ['"', "'"],
    keywords: words(
      "abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for if implements import instanceof int interface long native new null package private protected public record return short static super switch synchronized this throw throws transient true try var void volatile while",
    ),
  },
  c: { line: ["//"], block: ["/*", "*/"], multiline: [], quotes: ['"', "'"], keywords: words(`${C_LIKE} NULL bool true false`), preprocessor: true },
  cpp: {
    line: ["//"],
    block: ["/*", "*/"],
    multiline: [],
    quotes: ['"', "'"],
    keywords: words(`${C_LIKE} bool catch class constexpr delete explicit false friend namespace new noexcept nullptr operator override private protected public template this throw true try using virtual`),
    preprocessor: true,
  },
  javascript: { line: ["//"], block: ["/*", "*/"], multiline: ["`"], quotes: ['"', "'"], keywords: words(JS) },
  typescript: { line: ["//"], block: ["/*", "*/"], multiline: ["`"], quotes: ['"', "'"], keywords: words(`${JS} abstract any as boolean declare enum implements interface keyof namespace never number private protected public readonly string type unknown`) },
};

/**
 * The colouring rules for a file: its project's language when the file is one
 * of that language's (a `.h` in a C project is C), else the language its name
 * belongs to, else the project's language.
 */
export function languageOf(path: string, fallback?: string): string | undefined {
  const lower = path.toLowerCase();
  const owns = (l: { extensions: string[] }) => l.extensions.some((ext) => lower.endsWith(ext));
  const own = fallback ? getLanguage(fallback) : undefined;
  if (own && owns(own)) return own.id;
  return LANGUAGES.find(owns)?.id ?? fallback;
}

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)[A-Za-z]*/y;

/**
 * The text as lines of coloured pieces. Every character of the input is in
 * exactly one piece, in order, so joining the pieces of a line gives the line.
 */
export function highlight(text: string, language: string | undefined): Token[][] {
  const rules = language ? RULES[language] : undefined;
  const lines: Token[][] = [[]];
  const push = (piece: string, kind: TokenKind) => {
    const parts = piece.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      // Neighbouring pieces of one kind are one piece.
      if (last && last.kind === kind) last.text += part;
      else line.push({ text: part, kind });
    });
  };
  if (!rules) {
    push(text.replace(/\r\n?/g, "\n"), "plain");
    return lines;
  }
  const src = text.replace(/\r\n?/g, "\n");
  const until = (from: number, end: string, escapes: boolean, stopAtLineEnd: boolean): number => {
    let i = from;
    while (i < src.length) {
      if (escapes && src[i] === "\\") {
        i += 2;
        continue;
      }
      if (src.startsWith(end, i)) return i + end.length;
      if (stopAtLineEnd && src[i] === "\n") return i;
      i++;
    }
    return src.length;
  };
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\n") {
      push(ch, "plain");
      i++;
      lineStart = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push(ch, "plain");
      i++;
      continue;
    }
    const first = lineStart;
    lineStart = false;
    if (rules.preprocessor && first && ch === "#") {
      const end = until(i, "\n", false, true);
      // The directive is the keyword; what follows (a file name, a value) is plain or a string.
      const directive = /^#\s*\w+/.exec(src.slice(i, end))?.[0] ?? "#";
      push(directive, "keyword");
      i += directive.length;
      continue;
    }
    const lineComment = rules.line.find((c) => src.startsWith(c, i));
    if (lineComment) {
      const end = until(i, "\n", false, true);
      push(src.slice(i, end), "comment");
      i = end;
      continue;
    }
    if (rules.block && src.startsWith(rules.block[0], i)) {
      const end = until(i + rules.block[0].length, rules.block[1], false, false);
      push(src.slice(i, end), "comment");
      i = end;
      continue;
    }
    const long = rules.multiline.find((q) => src.startsWith(q, i));
    if (long) {
      const end = until(i + long.length, long, true, false);
      push(src.slice(i, end), "string");
      i = end;
      continue;
    }
    if (rules.quotes.includes(ch)) {
      const end = until(i + 1, ch, true, true);
      push(src.slice(i, end), "string");
      i = end;
      continue;
    }
    // An include's <file> reads as a string.
    if (rules.preprocessor && ch === "<" && /#\s*include\s*$/.test(src.slice(src.lastIndexOf("\n", i) + 1, i))) {
      const end = until(i + 1, ">", false, true);
      push(src.slice(i, end), "string");
      i = end;
      continue;
    }
    NUMBER.lastIndex = i;
    if (ch >= "0" && ch <= "9" && NUMBER.test(src)) {
      push(src.slice(i, NUMBER.lastIndex), "number");
      i = NUMBER.lastIndex;
      continue;
    }
    WORD.lastIndex = i;
    if (WORD.test(src)) {
      const word = src.slice(i, WORD.lastIndex);
      push(word, rules.keywords.has(word) ? "keyword" : "plain");
      i = WORD.lastIndex;
      continue;
    }
    push(ch, "plain");
    i++;
  }
  return lines;
}
