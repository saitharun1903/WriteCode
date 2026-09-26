import type { SourceFile } from "./types.js";

export interface CommandContext {
  entry: string;
  files: SourceFile[];
  sourceExtensions?: string[];
}

function stripExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(0, dot) : path;
}

/**
 * Expands `{entry}`, `{entryClass}` and `{sources}` placeholders in a
 * language command template. Returns an argv array; nothing is ever passed
 * through a shell, so file names cannot inject commands.
 */
export function expandCommand(template: readonly string[], ctx: CommandContext): string[] {
  const out: string[] = [];
  for (const arg of template) {
    if (arg === "{sources}") {
      const exts = ctx.sourceExtensions ?? [];
      const sources = ctx.files
        .map((f) => f.path)
        .filter((p) => exts.some((ext) => p.toLowerCase().endsWith(ext)))
        .sort();
      out.push(...sources);
      continue;
    }
    out.push(
      arg
        .replaceAll("{entryClass}", stripExtension(ctx.entry).replaceAll("/", "."))
        .replaceAll("{entry}", ctx.entry),
    );
  }
  return out;
}
