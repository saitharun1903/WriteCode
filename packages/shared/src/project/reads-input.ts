import { getLanguage } from "../languages/registry.js";
import type { ProjectFile } from "./types.js";

/** Ways each language reads standard input. Matched after comments are removed. */
const READERS: Record<string, RegExp> = {
  java: /\bSystem\s*\.\s*in\b|\bSystem\s*\.\s*console\s*\(/,
  python: /\binput\s*\(|\bsys\s*\.\s*stdin\b|\bfileinput\b|\bopen\s*\(\s*0\b/,
  cpp: /\bcin\b|\bscanf\s*\(|\bgetchar\s*\(|\bfgets\s*\(|\bfread\s*\(|\bgetline\s*\(|\bstdin\b/,
  c: /\bscanf\s*\(|\bgetchar\s*\(|\bfgets\s*\(|\bfread\s*\(|\bgetline\s*\(|\bgetc\s*\(\s*stdin|\bstdin\b/,
  javascript: /\bprocess\s*\.\s*stdin\b|\breadFileSync\s*\(\s*(0|["'`]\/dev\/stdin)|\breadline\b/,
  typescript: /\bprocess\s*\.\s*stdin\b|\breadFileSync\s*\(\s*(0|["'`]\/dev\/stdin)|\breadline\b/,
};

function stripComments(code: string, language: string): string {
  const noBlock = language === "python" ? code.replace(/("""|''')[\s\S]*?\1/g, "") : code.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(language === "python" ? /#.*$/gm : /\/\/.*$/gm, "");
}

/**
 * Whether any source file of the project reads standard input. A program
 * that never does prints the same output for every test input, which is the
 * first thing to tell someone whose tests all look alike.
 */
export function readsInput(language: string, files: readonly ProjectFile[]): boolean {
  const lang = getLanguage(language);
  const reader = READERS[language];
  if (!lang || !reader) return true;
  return files.some((f) => lang.extensions.some((e) => f.path.toLowerCase().endsWith(e)) && reader.test(stripComments(f.content, language)));
}

/** A few lines showing how to read "a count, then that many numbers" in each language. */
export const READ_INPUT_EXAMPLE: Record<string, string> = {
  java: `Scanner in = new Scanner(System.in);   // import java.util.Scanner;
int n = in.nextInt();
int[] arr = new int[n];
for (int i = 0; i < n; i++) arr[i] = in.nextInt();`,
  python: `n = int(input())
arr = list(map(int, input().split()))`,
  cpp: `int n;
std::cin >> n;
std::vector<int> arr(n);
for (int& x : arr) std::cin >> x;`,
  c: `int n;
scanf("%d", &n);
int arr[n];
for (int i = 0; i < n; i++) scanf("%d", &arr[i]);`,
  javascript: `const data = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);
const n = data[0];
const arr = data.slice(1, n + 1);`,
  typescript: `import { readFileSync } from "node:fs";
const data = readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);
const n = data[0];
const arr = data.slice(1, n + 1);`,
};
