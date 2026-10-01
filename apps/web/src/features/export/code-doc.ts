import { PRODUCT, getLanguage } from "@cw/shared";
import { highlight, languageOf, type TokenKind } from "@/lib/highlight";
import { buildCodePdf, loadLogoPixels, safeFileName, saveFile, type CodePdfInput } from "./code-pdf";

const SITE = "writecode.in";

/** The single file a download is made as. */
export type CodeFormat = "pdf" | "word" | "text";

export const CODE_FORMATS: { id: CodeFormat; label: string; extension: string; detail: string }[] = [
  { id: "pdf", label: "PDF", extension: "pdf", detail: "Framed pages with coloured code. Best for printing and sending." },
  { id: "word", label: "Word", extension: "doc", detail: "Opens in Word and Google Docs, where it can be edited." },
  { id: "text", label: "Text", extension: "txt", detail: "Only the code, as plain text. Opens anywhere." },
];

export type CodeInput = Omit<CodePdfInput, "logo">;

/** The entry file first, then the rest by name: the order every format uses. */
function ordered(input: CodeInput) {
  return [...input.files].sort((a, b) => Number(b.path === input.entryFile) - Number(a.path === input.entryFile) || a.path.localeCompare(b.path));
}

const clean = (content: string) => content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
const lineCount = (content: string) => (clean(content) ? clean(content).split("\n").length : 0);

function facts(input: CodeInput): string {
  const lang = getLanguage(input.language);
  const files = input.files.length;
  const lines = input.files.reduce((n, f) => n + lineCount(f.content), 0);
  const when = new Date(input.at ?? Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return `${lang ? `${lang.name} ${lang.version}` : input.language}  ·  ${files} file${files === 1 ? "" : "s"}  ·  ${lines} line${lines === 1 ? "" : "s"}  ·  ${when}`;
}

/**
 * The chosen files as plain text: the code and nothing else. One file is
 * exactly its code. Several files follow one another, each under a line with
 * its name, which is the only thing added (without it they could not be told apart).
 */
export function buildCodeText(input: CodeInput): string {
  const files = ordered(input);
  if (files.length === 1) return `${clean(files[0]!.content)}\n`;
  return files.map((file) => `===== ${file.path} =====\n${clean(file.content)}\n`).join("\n");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The colours of code on white paper, the same as in the PDF. */
const COLOR: Record<TokenKind, string> = { plain: "#1f2328", keyword: "#6638d1", string: "#147a3d", number: "#c25c05", comment: "#858c99" };

/**
 * The chosen files as a page Word opens as a document: a framed title, each
 * file's code coloured on a tinted band, and the product's name at the foot.
 * Colours are written on each piece because Word ignores most style sheets.
 */
export function buildCodeWordHtml(input: CodeInput): string {
  const files = ordered(input).map((file) => {
    const text = clean(file.content);
    const lines = highlight(text, languageOf(file.path, input.language));
    const code = text
      ? lines.map((tokens) => tokens.map((t) => `<span style="color:${COLOR[t.kind]}${t.kind === "keyword" ? ";font-weight:bold" : ""}">${escapeHtml(t.text)}</span>`).join("") || " ").join("\n")
      : `<span style="color:${COLOR.comment}">(empty file)</span>`;
    return `<h2 style="font:bold 11pt Calibri,Arial,sans-serif;color:#6b54e6;background:#f4f2ff;padding:5pt 8pt;margin:16pt 0 6pt">${escapeHtml(file.path)}</h2>
<pre style="font:9pt Consolas,'Courier New',monospace;line-height:1.35;margin:0;white-space:pre-wrap;word-wrap:break-word">${code}</pre>`;
  });
  return `<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(input.name)}</title>
<style>@page { margin: 2cm; } body { font-family: Calibri, Arial, sans-serif; color: #1f2328; }</style>
</head>
<body>
<div style="border:1.5pt solid #6b54e6;padding:14pt 16pt">
<h1 style="font:bold 20pt Calibri,Arial,sans-serif;margin:0">${escapeHtml(input.name)}</h1>
<p style="font-size:10pt;color:#6b727c;margin:4pt 0 0">${escapeHtml(facts(input))}</p>
<p style="margin:8pt 0 0;border-top:2pt solid #6b54e6;font-size:1pt">&nbsp;</p>
${files.join("\n")}
<p style="margin:22pt 0 0;padding-top:8pt;border-top:0.75pt solid #dcdce8;text-align:center;font-size:10pt"><b style="color:#6b54e6">${escapeHtml(PRODUCT.name)}</b> <span style="color:#6b727c">&nbsp;·&nbsp; ${SITE}</span></p>
</div>
</body>
</html>`;
}

/** The same page with the markers that make Word treat it as a document. */
function asWordDocument(html: string): string {
  return (
    "﻿" +
    html
      .replace('<html lang="en">', '<html lang="en" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">')
      .replace("<head>", "<head><!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->")
  );
}

/** Makes one file of the chosen code in the chosen format and downloads it. */
export async function downloadCode(input: CodeInput, format: CodeFormat) {
  const name = safeFileName(input.name);
  if (format === "pdf") saveFile(buildCodePdf({ ...input, logo: await loadLogoPixels() }) as Uint8Array<ArrayBuffer>, "application/pdf", `${name}.pdf`);
  else if (format === "word") saveFile(asWordDocument(buildCodeWordHtml(input)), "application/msword", `${name}.doc`);
  else saveFile(buildCodeText(input), "text/plain;charset=utf-8", `${name}.txt`);
}
