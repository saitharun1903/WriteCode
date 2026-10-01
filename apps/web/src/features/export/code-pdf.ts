import { PRODUCT, getLanguage, type ProjectFile } from "@cw/shared";
import { INK, MUTED, Pdf, pdfNumber as n, pdfSafe, pdfString, roundRectPath, textWidth } from "@/features/interview/pdf";
import { highlight, languageOf, type TokenKind } from "@/lib/highlight";

type Rgb = [number, number, number];

/** The brand's colours, as they print on white paper. */
export const BLUE: Rgb = [0.25, 0.39, 0.95];
export const VIOLET: Rgb = [0.42, 0.33, 0.9];
export const PINK: Rgb = [0.65, 0.25, 0.83];
export const TINT: Rgb = [0.955, 0.95, 1];

const TOKEN: Record<TokenKind, Rgb> = {
  plain: INK,
  keyword: [0.4, 0.22, 0.82],
  string: [0.08, 0.48, 0.24],
  number: [0.76, 0.36, 0.02],
  comment: [0.52, 0.55, 0.6],
};

const SITE = "writecode.in";
const CODE_SIZE = 8.6;
const LEAD = 12;

export interface CodePdfInput {
  name: string;
  language: string;
  entryFile: string;
  files: ProjectFile[];
  /** When the copy was made, ms. */
  at?: number;
  /** The logo, as raw RGB pixels (it cannot be read where there is no browser, e.g. in tests). */
  logo?: { width: number; height: number; rgb: Uint8Array };
}

export const rgb = (c: Rgb, op: "rg" | "RG") => `${c.map(n).join(" ")} ${op}`;

/** Every page's frame and watermark, drawn under the content. `name` is printed small at the foot, on the left. */
export function pageFurniture(pdf: Pdf, name: string, hasLogo: boolean, index: number, total: number): string {
  const w = pdf.width;
  const h = pdf.height;
  const ops: string[] = [];
  // The frame: a violet line with a hairline inside it.
  ops.push(`${rgb(VIOLET, "RG")} 1.3 w ${roundRectPath(20, 20, w - 40, h - 40, 13)} S`);
  ops.push(`0.86 0.85 0.97 RG 0.5 w ${roundRectPath(24.5, 24.5, w - 49, h - 49, 9.5)} S`);
  // Two corners carry the brand's gradient: blue at the top left, pink at the bottom right.
  ops.push("1 J 1 j 3.2 w");
  ops.push(`${rgb(BLUE, "RG")} ${n(20)} ${n(h - 96)} m ${n(20)} ${n(h - 33)} l ${n(20)} ${n(h - 26)} ${n(26)} ${n(h - 20)} ${n(33)} ${n(h - 20)} c ${n(96)} ${n(h - 20)} l S`);
  ops.push(`${rgb(PINK, "RG")} ${n(w - 20)} ${n(96)} m ${n(w - 20)} ${n(33)} l ${n(w - 20)} ${n(26)} ${n(w - 26)} ${n(20)} ${n(w - 33)} ${n(20)} c ${n(w - 96)} ${n(20)} l S`);
  ops.push("0 J 0 j");
  // The watermark: the product's name and address, centred at the foot of every page.
  const brand = PRODUCT.name;
  const rest = `  ·  ${SITE}`;
  const brandWidth = textWidth(brand, "bold", 9.5);
  const width = (hasLogo ? 17 : 0) + brandWidth + textWidth(rest, "regular", 9);
  let x = (w - width) / 2;
  const y = 37;
  ops.push(`0.9 0.9 0.94 RG 0.5 w ${n(pdf.margin)} ${n(y + 17)} m ${n(w - pdf.margin)} ${n(y + 17)} l S`);
  if (hasLogo) {
    ops.push(`q 12 0 0 12 ${n(x)} ${n(y - 2.5)} cm /Im1 Do Q`);
    x += 17;
  }
  ops.push(`BT /F2 9.5 Tf ${rgb(VIOLET, "rg")} ${n(x)} ${n(y)} Td (${pdfString(brand)}) Tj ET`);
  ops.push(`BT /F1 9 Tf ${rgb(MUTED, "rg")} ${n(x + brandWidth)} ${n(y)} Td (${pdfString(rest)}) Tj ET`);
  const page = `Page ${index + 1} of ${total}`;
  ops.push(`BT /F1 8 Tf ${rgb(MUTED, "rg")} ${n(w - pdf.margin - textWidth(page, "regular", 8))} ${n(y)} Td (${pdfString(page)}) Tj ET`);
  const title = pdfSafe(name).slice(0, 42);
  ops.push(`BT /F1 8 Tf ${rgb(MUTED, "rg")} ${n(pdf.margin)} ${n(y)} Td (${pdfString(title)}) Tj ET`);
  return ops.join("\n");
}

/**
 * A line of coloured pieces cut into rows of at most `max` characters. The
 * rows after the first are indented a step deeper than the line itself, so a
 * long statement reads as one.
 */
function rows(tokens: { text: string; kind: TokenKind }[], max: number): { text: string; kind: TokenKind }[][] {
  const out: { text: string; kind: TokenKind }[][] = [[]];
  const indent = Math.min(/^ */.exec(pdfSafe(tokens[0]?.text ?? ""))?.[0].length ?? 0, Math.floor(max / 2)) + 4;
  let used = 0;
  for (const token of tokens) {
    let text = pdfSafe(token.text);
    while (text) {
      if (used >= max) {
        // Spaces at a break are not carried over.
        text = text.replace(/^ +/, "");
        if (!text) break;
        out.push([{ text: " ".repeat(indent), kind: "plain" }]);
        used = indent;
      }
      const piece = text.slice(0, max - used);
      out[out.length - 1]!.push({ text: piece, kind: token.kind });
      used += piece.length;
      text = text.slice(piece.length);
    }
  }
  return out;
}

/** The brand's rule under a title: blue, violet, pink. */
export function brandRule(pdf: Pdf) {
  const third = pdf.inner / 3;
  [BLUE, VIOLET, PINK].forEach((c, i) => pdf.raw(`${rgb(c, "RG")} 1.6 w ${n(pdf.margin + third * i)} ${n(pdf.height - pdf.y)} m ${n(pdf.margin + third * (i + 1))} ${n(pdf.height - pdf.y)} l S`));
}

/**
 * One file: its name on a tinted band, then its code with line numbers and
 * coloured syntax, across pages. `note` is added after the line count.
 */
export function drawCodeFile(pdf: Pdf, file: ProjectFile, language: string, note = "") {
  const text = file.content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const source = highlight(text, languageOf(file.path, language));
  const digits = String(source.length).length;
  const gutter = digits * 0.6 * CODE_SIZE + 14;
  const max = Math.max(20, Math.floor((pdf.inner - gutter - 6) / (0.6 * CODE_SIZE)));

  // The file's name on a tinted band; never left alone at the foot of a page.
  pdf.need(22 + LEAD * 3);
  pdf.raw(`${rgb(TINT, "rg")} ${roundRectPath(pdf.margin, pdf.height - pdf.y - 20, pdf.inner, 20, 5)} f`);
  pdf.line(file.path, pdf.margin + 9, { font: "bold", size: 9.5, color: VIOLET });
  const count = `${text ? source.length : 0} line${text && source.length === 1 ? "" : "s"}${note ? `  ·  ${note}` : ""}`;
  pdf.y += 1;
  pdf.line(count, pdf.margin + pdf.inner - 9 - textWidth(count, "regular", 8), { size: 8, color: MUTED });
  pdf.y += 26;

  if (!text) {
    pdf.line("(empty file)", pdf.margin + gutter, { font: "mono", size: CODE_SIZE, color: MUTED });
    pdf.y += LEAD;
  }
  source.forEach((tokens, i) => {
    if (!text) return;
    rows(tokens, max).forEach((row, part) => {
      pdf.need(LEAD);
      if (part === 0) {
        const number = String(i + 1);
        pdf.line(number, pdf.margin + gutter - 10 - number.length * 0.6 * CODE_SIZE, { font: "mono", size: CODE_SIZE, color: [0.68, 0.7, 0.75] });
      }
      pdf.pieces(
        row.map((t) => ({ text: t.text, color: TOKEN[t.kind], font: t.kind === "keyword" ? ("monoBold" as const) : ("mono" as const) })),
        pdf.margin + gutter,
        CODE_SIZE,
      );
      pdf.y += LEAD;
    });
  });
  pdf.y += 14;
}

/**
 * A project's code as a PDF made to be kept and shown: a framed page, the
 * files one after another with line numbers and coloured syntax, and the
 * product's name at the foot of every page.
 */
export function buildCodePdf(input: CodePdfInput): Uint8Array {
  const pdf = new Pdf();
  const lang = getLanguage(input.language);
  // The entry file first, then the rest by name.
  const files = [...input.files].sort((a, b) => Number(b.path === input.entryFile) - Number(a.path === input.entryFile) || a.path.localeCompare(b.path));
  const lines = files.reduce((sum, f) => sum + f.content.replace(/\n+$/, "").split("\n").length, 0);
  const when = new Date(input.at ?? Date.now()).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  // The title block.
  pdf.y = 46;
  const textX = pdf.margin + (input.logo ? 38 : 0);
  if (input.logo) pdf.raw(`q 28 0 0 28 ${n(pdf.margin)} ${n(pdf.height - pdf.y - 29)} cm /Im1 Do Q`);
  pdf.line(pdfSafe(input.name).slice(0, 60), textX, { font: "bold", size: 17 });
  pdf.y += 21;
  pdf.line(`${lang ? `${lang.name} ${lang.version}` : input.language}  ·  ${files.length} file${files.length === 1 ? "" : "s"}  ·  ${lines} lines  ·  ${when}`, textX, { size: 9.5, color: MUTED });
  pdf.y += 20;
  brandRule(pdf);
  pdf.y += 14;

  for (const file of files) drawCodeFile(pdf, file, input.language, file.path === input.entryFile && files.length > 1 ? "runs first" : "");

  return pdf.build((index, total) => pageFurniture(pdf, input.name, !!input.logo, index, total), input.logo);
}

/** The logo as pixels for the PDF; undefined when it cannot be read (the PDF is then made without it). */
export async function loadLogoPixels(size = 96): Promise<CodePdfInput["logo"]> {
  try {
    const image = new Image();
    image.src = "/logo.png";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    // On white: the PDF's picture has no transparency.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    const pixels = new Uint8Array(size * size * 3);
    for (let i = 0, j = 0; i < data.length; i += 4) {
      pixels[j++] = data[i]!;
      pixels[j++] = data[i + 1]!;
      pixels[j++] = data[i + 2]!;
    }
    return { width: size, height: size, rgb: pixels };
  } catch {
    return undefined;
  }
}

/** Saves `bytes` as a file the browser downloads. */
export function saveFile(bytes: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9 _-]+/g, " ").trim().replace(/\s+/g, "-") || "code";

/** Makes the PDF of a project and downloads it. */
export async function downloadCodePdf(input: Omit<CodePdfInput, "logo">) {
  const pdf = buildCodePdf({ ...input, logo: await loadLogoPixels() });
  saveFile(pdf as Uint8Array<ArrayBuffer>, "application/pdf", `${safeFileName(input.name)}.pdf`);
}
