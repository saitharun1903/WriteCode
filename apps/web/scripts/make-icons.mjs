/**
 * Makes every icon from the brand mark (brand/writecode-mark.svg). Run after
 * changing the logo:
 *
 *   node scripts/make-icons.mjs
 *
 * Writes public/logo.png (the mark inside the app), icon-192/512.png,
 * apple-touch-icon.png, src/app/favicon.ico, and puts the mark on public/og.png.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// sharp comes with Next.js; no extra dependency.
const require = createRequire(createRequire(import.meta.url).resolve("next/package.json"));
const sharp = require("sharp");

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
/** The mark, drawn on a 16 x 16 grid: every size that is a multiple of 16 is pixel-exact. */
const SOURCE = readFileSync(at("brand/writecode-mark.svg"), "utf8");

/** The mark at `size`. `square`: no rounded corners (for platforms that round icons themselves). */
async function tile(size, square = false) {
  const svg = square ? SOURCE.replace('rx="3"', 'rx="0"') : SOURCE;
  // Drawn large, then brought to size without smoothing where it divides evenly, so the pixels stay sharp.
  return sharp(Buffer.from(svg), { density: (72 * size * 4) / 16 })
    .resize(size, size, { kernel: size % 16 === 0 ? "nearest" : "lanczos3" })
    .png()
    .toBuffer();
}

/** A .ico holding PNG images (supported by every current browser). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

writeFileSync(at("public/logo.png"), await tile(128));
writeFileSync(at("public/icon-192.png"), await tile(192));
writeFileSync(at("public/icon-512.png"), await tile(512));
// iOS shows its own rounded corners and no transparency.
writeFileSync(at("public/apple-touch-icon.png"), await tile(180, true));
writeFileSync(at("src/app/favicon.ico"), ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await tile(size) })))));

// The social preview: the new mark where the old one was (a 54 px tile at 72, 75).
const og = at("public/og.png");
const { data: px } = await sharp(og).raw().toBuffer({ resolveWithObject: true });
const i = (102 * 1200 + 60) * (px.length / (1200 * 630));
const bg = { r: px[i], g: px[i + 1], b: px[i + 2] };
const cover = await sharp({ create: { width: 62, height: 62, channels: 3, background: bg } }).png().toBuffer();
const updated = await sharp(og)
  .composite([
    { input: cover, left: 68, top: 71 },
    { input: await tile(56), left: 71, top: 74 },
  ])
  .png()
  .toBuffer();
writeFileSync(og, updated);
console.log("icons written");
