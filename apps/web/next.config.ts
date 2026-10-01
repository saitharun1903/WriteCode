import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

/** The editor's files are served from an address with its version in it (see scripts/copy-monaco.mjs). */
const monacoVersion = (JSON.parse(readFileSync(join(process.cwd(), "node_modules", "monaco-editor", "package.json"), "utf8")) as { version: string }).version;

const nextConfig: NextConfig = {
  // The floating dev indicator covers the tool-window stripe in the bottom-left corner.
  devIndicators: false,
  env: { NEXT_PUBLIC_MONACO_VERSION: monacoVersion },
  // The styles are small (utility classes): they travel in the page, not in a file the first paint waits for.
  experimental: { inlineCss: true },
  // Production images serve the IDE as static files from the reverse proxy (no Node server).
  ...(process.env.NEXT_OUTPUT === "export" ? { output: "export" as const } : {}),
};

export default nextConfig;
