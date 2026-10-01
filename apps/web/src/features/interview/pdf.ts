/**
 * A small PDF writer for the interview report: text in the standard fonts
 * (Helvetica, Courier), wrapped and paginated, with rules and filled boxes.
 * Enough for a clean document that every PDF reader opens, without shipping a
 * PDF library to every visitor.
 */

type Font = "regular" | "bold" | "mono" | "monoBold";
type Rgb = [number, number, number];

const FONT_ID: Record<Font, string> = { regular: "F1", bold: "F2", mono: "F3", monoBold: "F4" };
const FONT_NAME: Record<Font, string> = { regular: "Helvetica", bold: "Helvetica-Bold", mono: "Courier", monoBold: "Courier-Bold" };

/** Helvetica advance widths for the characters 32 to 126, in thousandths of the font size. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const REPLACE: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−‒]/g, "-"],
  [/…/g, "..."],
  [/→/g, "->"],
  [/←/g, "<-"],
  [/↔/g, "<->"],
  [/≤/g, "<="],
  [/≥/g, ">="],
  [/≠/g, "!="],
  [/√/g, "sqrt"],
  [/•/g, "-"],
  [/ /g, " "],
  [/\t/g, "    "],
];

/** Text as the standard fonts can show it: Latin-1, with common symbols spelled out and the rest as "?". */
export function pdfSafe(text: string): string {
  let out = text;
  for (const [from, to] of REPLACE) out = out.replace(from, to);
  return out.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "").replace(/[^\u0000-ÿ]/g, "?");
}

export function textWidth(text: string, font: Font, size: number): number {
  if (font === "mono" || font === "monoBold") return text.length * 0.6 * size;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += HELVETICA[text.charCodeAt(i) - 32] ?? 556;
  // The bold face is a little wider; near enough for wrapping.
  return (w / 1000) * size * (font === "bold" ? 1.07 : 1);
}

/** Breaks `text` into lines no wider than `width`; words longer than a line are cut. Line breaks are kept. */
export function wrap(text: string, font: Font, size: number, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (textWidth(raw, font, size) <= width) {
      out.push(raw);
      continue;
    }
    // Code keeps its indentation on continued lines; prose breaks at spaces.
    const indent = font === "mono" || font === "monoBold" ? (/^ */.exec(raw)?.[0] ?? "") : "";
    let line = "";
    for (const word of raw.split(/(?<= )/)) {
      let piece = word;
      while (textWidth(line + piece, font, size) > width) {
        if (line.trim()) {
          out.push(line.replace(/ +$/, ""));
          line = indent;
          continue;
        }
        // One word wider than the line: cut it.
        let n = piece.length;
        while (n > 1 && textWidth(line + piece.slice(0, n), font, size) > width) n--;
        out.push(line + piece.slice(0, n));
        piece = piece.slice(n);
        line = indent;
      }
      line += piece;
    }
    out.push(line.replace(/ +$/, ""));
  }
  return out;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

/** Text ready to stand between the brackets of a PDF string. */
export const pdfString = (s: string) => esc(pdfSafe(s));
/** A number as PDF operators take it. */
export const pdfNumber = (v: number) => n(v);

/** The path of a rectangle with rounded corners, in page coordinates (from the bottom left). */
export function roundRectPath(x: number, y: number, width: number, height: number, r: number): string {
  const k = r * 0.5523;
  return [
    `${n(x + r)} ${n(y)} m`,
    `${n(x + width - r)} ${n(y)} l`,
    `${n(x + width - r + k)} ${n(y)} ${n(x + width)} ${n(y + r - k)} ${n(x + width)} ${n(y + r)} c`,
    `${n(x + width)} ${n(y + height - r)} l`,
    `${n(x + width)} ${n(y + height - r + k)} ${n(x + width - r + k)} ${n(y + height)} ${n(x + width - r)} ${n(y + height)} c`,
    `${n(x + r)} ${n(y + height)} l`,
    `${n(x + r - k)} ${n(y + height)} ${n(x)} ${n(y + height - r + k)} ${n(x)} ${n(y + height - r)} c`,
    `${n(x)} ${n(y + r)} l`,
    `${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c`,
    "h",
  ].join(" ");
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export interface TextStyle {
  font?: Font;
  size?: number;
  color?: Rgb;
  /** Left edge, from the left margin. */
  indent?: number;
  /** Space kept free on the right. */
  right?: number;
  /** Space after the block. */
  after?: number;
  /** Line height as a multiple of the size. */
  leading?: number;
}

export const INK: Rgb = [0.12, 0.14, 0.16];
export const MUTED: Rgb = [0.42, 0.45, 0.49];
export const GREEN: Rgb = [0.1, 0.5, 0.22];
export const RED: Rgb = [0.81, 0.13, 0.18];
export const AMBER: Rgb = [0.7, 0.42, 0];

export class Pdf {
  readonly width = 595.28;
  readonly height = 841.89;
  readonly margin = 50;
  private pages: string[] = [""];
  /** Distance of the next line's top from the top of the page. */
  y = this.margin;

  get inner(): number {
    return this.width - 2 * this.margin;
  }

  private add(ops: string) {
    this.pages[this.pages.length - 1] += `${ops}\n`;
  }

  /** Drawing operators as they are, for shapes this class has no method for. */
  raw(ops: string) {
    this.add(ops);
  }

  /** How many pages there are so far. */
  get pageCount(): number {
    return this.pages.length;
  }

  /** One line made of pieces in different colours, starting at `x`. Returns where it ended. */
  pieces(parts: { text: string; color?: Rgb; font?: Font }[], x: number, size: number): number {
    let at = x;
    for (const part of parts) {
      const text = pdfSafe(part.text);
      if (!text) continue;
      this.line(text, at, { font: part.font ?? "mono", size, color: part.color ?? INK });
      at += textWidth(text, part.font ?? "mono", size);
    }
    return at;
  }

  newPage() {
    this.pages.push("");
    this.y = this.margin;
  }

  /** Starts a new page unless `height` more fits on this one. */
  need(height: number) {
    if (this.y + height > this.height - this.margin - 14) this.newPage();
  }

  space(height: number) {
    this.y += height;
  }

  /** One line at an exact place; `x` from the left edge of the page. */
  line(text: string, x: number, style: TextStyle = {}) {
    const { font = "regular", size = 10, color = INK } = style;
    this.add(`BT /${FONT_ID[font]} ${n(size)} Tf ${color.map(n).join(" ")} rg ${n(x)} ${n(this.height - this.y - size)} Td (${esc(pdfSafe(text))}) Tj ET`);
  }

  /** A block of wrapped text at the current position. */
  text(text: string, style: TextStyle = {}) {
    const { font = "regular", size = 10, indent = 0, right = 0, after = 0, leading = 1.4 } = style;
    const lines = wrap(pdfSafe(text), font, size, this.inner - indent - right);
    for (const l of lines) {
      this.need(size * leading);
      this.line(l, this.margin + indent, style);
      this.y += size * leading;
    }
    this.y += after;
  }

  rule(color: Rgb = [0.86, 0.88, 0.9]) {
    this.add(`${color.map(n).join(" ")} RG 0.6 w ${n(this.margin)} ${n(this.height - this.y)} m ${n(this.width - this.margin)} ${n(this.height - this.y)} l S`);
  }

  /** A filled box behind what is drawn next; `top` and `height` in page units from the top. */
  box(x: number, top: number, width: number, height: number, color: Rgb) {
    this.add(`${color.map(n).join(" ")} rg ${n(x)} ${n(this.height - top - height)} ${n(width)} ${n(height)} re f`);
  }

  heading(text: string) {
    this.need(46);
    this.y += 14;
    this.text(text, { font: "bold", size: 13, after: 3 });
    this.rule();
    this.y += 8;
  }

  /** Label and value in two columns; a long value wraps under itself. */
  row(label: string, value: string, color: Rgb = INK) {
    const labelWidth = 150;
    const size = 10;
    const lines = wrap(pdfSafe(value || "-"), "regular", size, this.inner - labelWidth);
    this.need(lines.length * size * 1.45);
    this.line(label, this.margin, { size, color: MUTED });
    for (const l of lines) {
      this.line(l, this.margin + labelWidth, { size, color });
      this.y += size * 1.45;
    }
    this.y += 2;
  }

  /** Source code or program output: fixed-width on a light background, wrapped, across pages. */
  code(text: string) {
    const size = 8.5;
    const lead = size * 1.35;
    const lines = wrap(pdfSafe(text.replace(/\s+$/, "")), "mono", size, this.inner - 16);
    let i = 0;
    while (i < lines.length) {
      this.need(lead * 2 + 10);
      const fit = Math.max(1, Math.floor((this.height - this.margin - 14 - this.y - 10) / lead));
      const chunk = lines.slice(i, i + fit);
      this.box(this.margin, this.y, this.inner, chunk.length * lead + 10, [0.96, 0.97, 0.98]);
      this.y += 5;
      for (const l of chunk) {
        this.line(l, this.margin + 8, { font: "mono", size });
        this.y += lead;
      }
      this.y += 5;
      i += chunk.length;
      if (i < lines.length) this.newPage();
    }
    this.y += 6;
  }

  /**
   * The finished document. `footer` is printed at the bottom of every page with
   * the page number; given as a function, it draws the page's furniture itself
   * (operators for page `index` of `total`, drawn under the content). `image` is
   * a picture pages can draw with `/Im1 Do` (raw RGB, 8 bits a channel).
   */
  build(footer: string | ((index: number, total: number) => string), image?: { width: number; height: number; rgb: Uint8Array }): Uint8Array {
    const total = this.pages.length;
    const objects: string[] = [];
    const add = (body: string) => objects.push(body);
    const fonts = (Object.keys(FONT_ID) as Font[]).map((f, i) => ({ f, id: 3 + i }));
    const firstPage = 3 + fonts.length;
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(`<< /Type /Pages /Count ${total} /Kids [${this.pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ")}] >>`);
    for (const { f } of fonts) add(`<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME[f]} /Encoding /WinAnsiEncoding >>`);
    const imageId = firstPage + total * 2;
    const resources = `<< /Font << ${fonts.map(({ f, id }) => `/${FONT_ID[f]} ${id} 0 R`).join(" ")} >>${image ? ` /XObject << /Im1 ${imageId} 0 R >>` : ""} >>`;
    this.pages.forEach((content, i) => {
      const label = typeof footer === "string" ? `${footer}   -   Page ${i + 1} of ${total}` : "";
      const stream = typeof footer === "string" ? `${content}BT /F1 8 Tf ${MUTED.map(n).join(" ")} rg ${n(this.margin)} 30 Td (${esc(pdfSafe(label))}) Tj ET\n` : `${footer(i, total)}\n${content}`;
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] /Resources ${resources} /Contents ${firstPage + i * 2 + 1} 0 R >>`);
      add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    });
    if (image) {
      // The pixels as they are, one byte a channel: small pictures need no compression.
      let pixels = "";
      for (let i = 0; i < image.rgb.length; i += 8192) pixels += String.fromCharCode(...image.rgb.subarray(i, i + 8192));
      add(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`);
    }
    let out = "%PDF-1.4\n%âãÏÓ\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    // Every character is one byte (Latin-1), so offsets in the string are offsets in the file.
    return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
  }
}
