import qrcode from "qrcode-generator";

/** Modules left blank around the code, as scanners need. */
export const QUIET = 4;

export interface Qr {
  /** Modules per side. */
  size: number;
  /** True where the module is dark. */
  dark: (row: number, col: number) => boolean;
  /** The square in the middle kept clear for the logo: modules [from, to). */
  hole: { from: number; to: number };
}

/**
 * The QR code for `text`, with room in the middle for a logo. It is made at
 * the highest error-correction level, which lets a scanner rebuild up to 30%
 * of the code; the logo covers under 6%, so it still scans at once.
 */
export function makeQr(text: string): Qr {
  const qr = qrcode(0, "H");
  qr.addData(text, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  // An odd number of modules, centred: about a fifth of the side.
  let side = Math.round(size * 0.22);
  if (side % 2 !== size % 2) side += 1;
  const from = (size - side) / 2;
  const hole = { from, to: from + side };
  const inHole = (r: number, c: number) => r >= hole.from && r < hole.to && c >= hole.from && c < hole.to;
  return { size, hole, dark: (r, c) => r >= 0 && c >= 0 && r < size && c < size && !inHole(r, c) && qr.isDark(r, c) };
}

/** True for the modules of the three corner squares scanners look for; they are drawn as rings, not dots. */
export function inFinder(size: number, row: number, col: number): boolean {
  const near = (v: number) => v < 7;
  const far = (v: number) => v >= size - 7;
  return (near(row) && near(col)) || (near(row) && far(col)) || (far(row) && near(col));
}

export interface QrArt {
  /** Side of the picture in its own units (one module is one unit), quiet zone included. */
  side: number;
  svg: string;
}

/**
 * The code as a picture: round dots in the brand's gradient, ringed corner
 * squares, and the logo in the middle. Kept dark enough on white for any
 * camera to read.
 */
export function qrSvg(text: string, logoHref?: string): QrArt {
  const qr = makeQr(text);
  const side = qr.size + QUIET * 2;
  const dots: string[] = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.dark(r, c) || inFinder(qr.size, r, c)) continue;
      // Full-size modules, only softened at the corners: gaps between dots make a code harder to read.
      dots.push(`<rect x="${c + QUIET}" y="${r + QUIET}" width="1.02" height="1.02" rx="0.28"/>`);
    }
  }
  const finder = (row: number, col: number) => {
    const x = col + QUIET;
    const y = row + QUIET;
    // The corner squares keep their exact proportions (1:1:3:1:1), which is what scanners look for; only the corners are rounded.
    return `<path fill-rule="evenodd" d="M${x + 1.3} ${y}h4.4a1.3 1.3 0 0 1 1.3 1.3v4.4a1.3 1.3 0 0 1-1.3 1.3h-4.4a1.3 1.3 0 0 1-1.3-1.3v-4.4a1.3 1.3 0 0 1 1.3-1.3zM${x + 1.5} ${y + 1}a0.5 0.5 0 0 0-0.5 0.5v4a0.5 0.5 0 0 0 0.5 0.5h4a0.5 0.5 0 0 0 0.5-0.5v-4a0.5 0.5 0 0 0-0.5-0.5z"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.7"/>`;
  };
  const hole = qr.hole.to - qr.hole.from;
  const at = qr.hole.from + QUIET;
  const logo = logoHref
    ? `<rect x="${at + 0.2}" y="${at + 0.2}" width="${hole - 0.4}" height="${hole - 0.4}" rx="${hole * 0.24}" fill="#fff"/><image href="${logoHref}" x="${at + 0.55}" y="${at + 0.55}" width="${hole - 1.1}" height="${hole - 1.1}" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" role="img" aria-label="QR code" shape-rendering="geometricPrecision">`,
    `<rect width="${side}" height="${side}" fill="#fff"/>`,
    `<g fill="#15161a">${dots.join("")}${finder(0, 0)}${finder(0, qr.size - 7)}${finder(qr.size - 7, 0)}</g>`,
    logo,
    "</svg>",
  ].join("");
  return { side, svg };
}
