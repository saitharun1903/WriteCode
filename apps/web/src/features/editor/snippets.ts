import type { Monaco } from "@monaco-editor/react";
import type { editor, languages, Position } from "monaco-editor";

/**
 * Editor snippets under the names people already type in IntelliJ and VS Code
 * (`psvm`, `sout`, `fori`...). Bodies use Monaco's snippet syntax: `$1` and
 * `${1:name}` are the Tab stops, `$0` is where the cursor ends, and
 * `${TM_FILENAME_BASE}` is the file name without its extension.
 */
export interface Snippet {
  prefix: string;
  /** What it writes, shown next to the prefix in the suggestion list. */
  detail: string;
  body: string;
}

const JAVA: Snippet[] = [
  { prefix: "psvm", detail: "main method", body: "public static void main(String[] args) {\n\t$0\n}" },
  { prefix: "main", detail: "class with a main method", body: "public class ${TM_FILENAME_BASE} {\n\tpublic static void main(String[] args) {\n\t\t$0\n\t}\n}" },
  { prefix: "sout", detail: "System.out.println()", body: "System.out.println($0);" },
  { prefix: "souf", detail: "System.out.printf()", body: 'System.out.printf("${1:%d}%n", $2);$0' },
  { prefix: "serr", detail: "System.err.println()", body: "System.err.println($0);" },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
  { prefix: "forr", detail: "for (int i = n - 1; i >= 0; i--)", body: "for (int ${1:i} = ${2:n} - 1; ${1:i} >= 0; ${1:i}--) {\n\t$0\n}" },
  { prefix: "iter", detail: "for (T x : items)", body: "for (${1:int} ${2:x} : ${3:items}) {\n\t$0\n}" },
  { prefix: "while", detail: "while loop", body: "while (${1:condition}) {\n\t$0\n}" },
  { prefix: "ifelse", detail: "if / else", body: "if (${1:condition}) {\n\t$2\n} else {\n\t$0\n}" },
  { prefix: "tryc", detail: "try / catch", body: "try {\n\t$1\n} catch (${2:Exception} e) {\n\t$0\n}" },
  { prefix: "sc", detail: "Scanner reading input", body: "Scanner ${1:in} = new Scanner(System.in);$0" },
  { prefix: "readint", detail: "read n, then n numbers", body: "int ${1:n} = ${2:in}.nextInt();\nint[] ${3:arr} = new int[${1:n}];\nfor (int i = 0; i < ${1:n}; i++) ${3:arr}[i] = ${2:in}.nextInt();$0" },
];

const PYTHON: Snippet[] = [
  { prefix: "main", detail: 'if __name__ == "__main__":', body: 'def main():\n\t$0\n\n\nif __name__ == "__main__":\n\tmain()' },
  { prefix: "fori", detail: "for i in range(n):", body: "for ${1:i} in range(${2:n}):\n\t$0" },
  { prefix: "fore", detail: "for x in items:", body: "for ${1:x} in ${2:items}:\n\t$0" },
  { prefix: "def", detail: "function", body: "def ${1:name}(${2}):\n\t$0" },
  { prefix: "class", detail: "class with __init__", body: "class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t$0" },
  { prefix: "trye", detail: "try / except", body: "try:\n\t$1\nexcept ${2:Exception} as e:\n\t$0" },
  { prefix: "inint", detail: "n = int(input())", body: "${1:n} = int(input())$0" },
  { prefix: "inlist", detail: "numbers from one input line", body: "${1:nums} = list(map(int, input().split()))$0" },
];

const CPP: Snippet[] = [
  {
    prefix: "main",
    detail: "program with main()",
    body: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n\tios::sync_with_stdio(false);\n\tcin.tie(nullptr);\n\t$0\n\treturn 0;\n}",
  },
  { prefix: "cout", detail: "cout << ... << endl", body: 'cout << $1 << "\\n";$0' },
  { prefix: "cin", detail: "cin >> ...", body: "cin >> $1;$0" },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
  { prefix: "forr", detail: "for (int i = n - 1; i >= 0; i--)", body: "for (int ${1:i} = ${2:n} - 1; ${1:i} >= 0; ${1:i}--) {\n\t$0\n}" },
  { prefix: "fore", detail: "for (auto& x : items)", body: "for (auto& ${1:x} : ${2:items}) {\n\t$0\n}" },
  { prefix: "readvec", detail: "read n, then n numbers", body: "int ${1:n};\ncin >> ${1:n};\nvector<int> ${2:a}(${1:n});\nfor (auto& x : ${2:a}) cin >> x;$0" },
];

const C: Snippet[] = [
  { prefix: "main", detail: "program with main()", body: "#include <stdio.h>\n\nint main(void) {\n\t$0\n\treturn 0;\n}" },
  { prefix: "printf", detail: 'printf("...\\n")', body: 'printf("${1:%d}\\n", $2);$0' },
  { prefix: "scanf", detail: 'scanf("%d", &x)', body: 'scanf("${1:%d}", &${2:x});$0' },
  { prefix: "fori", detail: "for (int i = 0; i < n; i++)", body: "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
];

const JS: Snippet[] = [
  { prefix: "log", detail: "console.log()", body: "console.log($0);" },
  { prefix: "fori", detail: "for (let i = 0; i < n; i++)", body: "for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t$0\n}" },
  { prefix: "forof", detail: "for (const x of items)", body: "for (const ${1:x} of ${2:items}) {\n\t$0\n}" },
  { prefix: "fn", detail: "function", body: "function ${1:name}(${2}) {\n\t$0\n}" },
  {
    prefix: "readinput",
    detail: "all of stdin as numbers",
    body: 'const ${1:data} = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);$0',
  },
];

const TS: Snippet[] = [
  ...JS.filter((s) => s.prefix !== "readinput"),
  {
    prefix: "readinput",
    detail: "all of stdin as numbers",
    body: 'const ${1:data} = require("node:fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);$0',
  },
];

export const SNIPPETS: Record<string, Snippet[]> = { java: JAVA, python: PYTHON, cpp: CPP, c: C, javascript: JS, typescript: TS };

let installed = false;

/** Registers the snippets once for every language that has them. */
export function installSnippets(monaco: Monaco) {
  if (installed) return;
  installed = true;
  for (const [language, snippets] of Object.entries(SNIPPETS)) {
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        const word = model.getWordUntilPosition(position);
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        // Only offer snippets while typing a word, never after a dot (member access).
        const before = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
        if (/\.\s*$/.test(before)) return { suggestions: [] };
        const suggestions: languages.CompletionItem[] = snippets.map((s, i) => ({
          label: { label: s.prefix, description: s.detail },
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: "```\n" + s.body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{TM_FILENAME_BASE\}/g, "Main").replace(/\$\d/g, "") + "\n```" },
          range,
          // Ahead of plain word suggestions, in the order listed above (the most used first).
          sortText: `0${String(i).padStart(2, "0")}`,
        }));
        return { suggestions };
      },
    });
  }
}
