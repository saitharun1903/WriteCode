import type { SourceFile } from "@cw/shared";

/**
 * Packs files into argv for a single `sh` invocation that decodes them into the
 * workspace. Using arguments (not stdin) avoids relying on half-closed hijacked
 * streams, which Docker's Windows named pipe transport does not support.
 *
 * Paths are validated upstream (`isSafeRelativePath`), and they reach the
 * script only as positional parameters, never interpolated into shell code.
 */

/** Linux caps a single argv string at 128 KiB (MAX_ARG_STRLEN). Stay well below. */
const MAX_ARG_CHARS = 96 * 1024;
/** Stay well below the ~2 MiB total ARG_MAX, leaving room for the environment. */
const MAX_BATCH_CHARS = 1024 * 1024;

export const WRITE_SCRIPT = [
  "set -eu",
  'while [ "$#" -gt 0 ]; do',
  '  mode="$1"; path="$2"; data="$3"; shift 3',
  '  mkdir -p "$(dirname -- "$path")"',
  '  if [ "$mode" = "w" ]; then printf %s "$data" | base64 -d > "$path"; else printf %s "$data" | base64 -d >> "$path"; fi',
  "done",
].join("\n");

export interface WriteBatch {
  argv: string[];
}

/** Splits files into `sh -c WRITE_SCRIPT` invocations of bounded size. */
export function buildWriteBatches(files: readonly SourceFile[]): WriteBatch[] {
  const batches: WriteBatch[] = [];
  let args: string[] = [];
  let size = 0;

  const flush = () => {
    if (args.length === 0) return;
    batches.push({ argv: ["sh", "-c", WRITE_SCRIPT, "sh", ...args] });
    args = [];
    size = 0;
  };

  for (const file of files) {
    const b64 = Buffer.from(file.content, "utf8").toString("base64");
    // Chunk on 4-char boundaries so each piece decodes independently.
    const chunkSize = MAX_ARG_CHARS - (MAX_ARG_CHARS % 4);
    const chunks = b64.length === 0 ? [""] : Array.from({ length: Math.ceil(b64.length / chunkSize) }, (_, i) => b64.slice(i * chunkSize, (i + 1) * chunkSize));
    chunks.forEach((chunk, i) => {
      const cost = chunk.length + file.path.length + 8;
      if (size + cost > MAX_BATCH_CHARS) flush();
      args.push(i === 0 ? "w" : "a", file.path, chunk);
      size += cost;
    });
  }
  flush();
  return batches;
}
