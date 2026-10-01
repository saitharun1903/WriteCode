// Serves Monaco from our own origin instead of a third-party CDN.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let pkgDir;
try {
  // package.json is not exported, so resolve the CJS entry (min/vs/index.js) and walk up.
  pkgDir = dirname(dirname(dirname(require.resolve("monaco-editor"))));
} catch {
  console.warn("[copy-monaco] monaco-editor not installed yet; skipping");
  process.exit(0);
}
const src = join(pkgDir, "min", "vs");
// The address carries the version, so the files can be cached for good: a new version is a new address.
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "monaco");
const dest = join(root, version, "vs");
if (!existsSync(src)) {
  console.error(`[copy-monaco] ${src} not found`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-monaco] copied Monaco to public/monaco/${version}/vs`);
