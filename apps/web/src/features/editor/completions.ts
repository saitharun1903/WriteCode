import type { Monaco } from "@monaco-editor/react";
import type { editor, IRange, languages, Position } from "monaco-editor";
import { isRestricted } from "@/features/interview/restrict";
import { COMPLETIONS, type Entry, type LanguageCompletions } from "./completions-data";
import { SNIPPETS, type Snippet } from "./snippets";

/**
 * Suggestions while typing, in every language: after `Math.` or `fmt.` the
 * members of that module, after any other value the language's common
 * methods, and elsewhere its keywords, built-in functions and snippets
 * (`sout`, `fori`...). JavaScript and TypeScript get their members from
 * Monaco's own language service, HTML and CSS their tags and properties.
 * Whether they pop up by themselves is the "Suggestions while typing" setting;
 * Ctrl+Space shows them either way.
 */

const LINE_COMMENT: Record<string, RegExp> = {
  python: /#/,
  ruby: /#/,
  shell: /(^|\s)#/,
  sql: /--/,
  php: /\/\/|#(?!\[)/,
};
const C_COMMENT = /\/\//;

/** Is the end of `before` inside a string or a line comment? (A quick look at the line, not a parser.) */
function inStringOrComment(before: string, language: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < before.length; i++) {
    const c = before[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // A Rust lifetime or a char like 'a' in C is short; a quote that does not close is still a string.
      quote = c;
      continue;
    }
    const rest = before.slice(i);
    const comment = LINE_COMMENT[language] ?? C_COMMENT;
    const m = comment.exec(rest);
    if (m && m.index === 0) return true;
    if (language === "c" || language === "cpp" || language === "java" || language === "csharp" || language === "go" || language === "rust" || language === "kotlin" || language === "javascript" || language === "typescript") {
      if (rest.startsWith("/*")) return true;
    }
  }
  return quote !== null;
}

/** The receiver of a member access ending `before` (`System.out.`, `std::`, `$x->`), or null. */
function receiverOf(before: string, data: LanguageCompletions | undefined): { receiver: string; op: string } | null {
  const ops = ["\\.", ...(data?.access ?? []).map((o) => (o === "->" ? "->" : "::"))];
  const m = new RegExp(`(\\$?[A-Za-z_][\\w]*(?:(?:\\.|::)[A-Za-z_]\\w*)*)?(?:\\(\\)|\\]|\\))?\\s*(${ops.join("|")})$`).exec(before);
  if (!m) return null;
  return { receiver: m[1] ?? "", op: m[2]! };
}

/** Splits "a, b(c, d), |x, y| z" at its top-level commas. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let pipe = false;
  let cur = "";
  for (const c of s) {
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "|") pipe = !pipe;
    if (c === "," && depth === 0 && !pipe) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const esc = (s: string) => s.replace(/[\\$}]/g, "\\$&");

interface Parsed {
  name: string;
  signature: string;
  insert: string;
  call: boolean;
}

/** "max(a, b)" -> name "max", insert "max(${1:a}, ${2:b})"; "map { it }" -> "map { ${1:it} }". */
export function parseEntry(text: string): Parsed {
  const name = /^[\w$!?:.]+/.exec(text)?.[0] ?? text;
  const rest = text.slice(name.length);
  let stop = 1;
  let insert = esc(name);
  let call = false;
  let i = 0;
  while (i < rest.length) {
    const c = rest[i]!;
    if (c === "(" || (c === "[" && name.endsWith("!"))) {
      const close = c === "(" ? ")" : "]";
      let depth = 0;
      let j = i;
      for (; j < rest.length; j++) {
        if (rest[j] === c) depth++;
        else if (rest[j] === close && --depth === 0) break;
      }
      const params = splitParams(rest.slice(i + 1, j));
      insert += c + params.map((p) => `\${${stop++}:${esc(p)}}`).join(", ") + close;
      call = true;
      i = j + 1;
    } else if (c === "{") {
      const j = rest.indexOf("}", i);
      const inner = rest.slice(i + 1, j < 0 ? undefined : j).trim();
      insert += inner ? `{ \${${stop++}:${esc(inner)}} }` : "{ $0 }";
      call = true;
      i = j < 0 ? rest.length : j + 1;
    } else {
      insert += esc(c);
      i++;
    }
  }
  return { name, signature: rest, insert, call };
}

let installed = false;

export function installCompletions(monaco: Monaco) {
  if (installed) return;
  installed = true;
  const Kind = monaco.languages.CompletionItemKind;
  const asSnippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;

  const item = (entry: Entry, range: IRange, group: string, member: boolean, nextIsParen: boolean): languages.CompletionItem => {
    const [text, note = ""] = typeof entry === "string" ? [entry] : entry;
    const p = parseEntry(text);
    const kind = /^(Module|Package)\b/.test(note)
      ? Kind.Module
      : p.call
        ? member
          ? Kind.Method
          : Kind.Function
        : /^[A-Z][A-Z0-9_]+$/.test(p.name)
          ? Kind.Constant
          : /^[A-Z]/.test(p.name)
            ? Kind.Class
            : member
              ? Kind.Property
              : Kind.Variable;
    return {
      label: { label: p.name, detail: p.signature || undefined, description: note || undefined },
      kind,
      // With "(" already typed after the cursor, only the name.
      insertText: nextIsParen && p.call ? p.name : p.insert,
      insertTextRules: asSnippet,
      filterText: p.name,
      documentation: note ? { value: `\`${text}\`\n\n${note}` } : undefined,
      range,
      sortText: `${group}${p.name.toLowerCase()}`,
    };
  };

  const snippetItem = (s: Snippet, i: number, range: IRange): languages.CompletionItem => ({
    label: { label: s.prefix, description: s.detail },
    kind: Kind.Snippet,
    insertText: s.body,
    insertTextRules: asSnippet,
    documentation: { value: "```\n" + s.body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{TM_FILENAME_BASE\}/g, "Main").replace(/\\\$/g, "$").replace(/\$\d/g, "") + "\n```" },
    range,
    // Ahead of everything else, in the order listed (the most used first).
    sortText: `0${String(i).padStart(2, "0")}`,
  });

  for (const language of new Set([...Object.keys(SNIPPETS), ...Object.keys(COMPLETIONS)])) {
    const data = COMPLETIONS[language];
    const snippets = SNIPPETS[language] ?? [];
    const triggers = data ? [".", ...(data.access?.includes("::") ? [":"] : []), ...(data.access?.includes("->") ? [">"] : [])] : undefined;
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: triggers,
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (isRestricted()) return { suggestions: [] };
        const line = model.getLineContent(position.lineNumber);
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const before = line.slice(0, word.startColumn - 1);
        const nextIsParen = line.slice(word.endColumn - 1).startsWith("(");
        if (language !== "html" && language !== "css" && inStringOrComment(before, language)) return { suggestions: [] };
        const access = receiverOf(before, data);
        if (access) {
          // A ":" alone (not "::") or a ">" alone (not "->") is not a member access.
          if (!data) return { suggestions: [] };
          const known = data.members[access.receiver] ?? data.members[access.receiver.split(/\.|::/).slice(-1)[0] ?? ""];
          const list = known ?? (access.op === "::" ? [] : data.methods);
          return { suggestions: list.map((e) => item(e, range, "1", true, nextIsParen)) };
        }
        const suggestions: languages.CompletionItem[] = snippets.map((s, i) => snippetItem(s, i, range));
        if (data) {
          for (const e of data.builtins) suggestions.push(item(e, range, "2", false, nextIsParen));
          for (const k of data.keywords) {
            suggestions.push({ label: k, kind: Kind.Keyword, insertText: k, range, sortText: `3${k.toLowerCase()}` });
          }
        }
        return { suggestions };
      },
    });
  }
}

/** How many suggestions each language has (for the settings page). */
export function suggestionCount(language: string): number {
  const d = COMPLETIONS[language];
  const members = d ? Object.values(d.members).reduce((n, list) => n + list.length, 0) : 0;
  return (SNIPPETS[language]?.length ?? 0) + (d ? d.keywords.length + d.builtins.length + d.methods.length + members : 0);
}
