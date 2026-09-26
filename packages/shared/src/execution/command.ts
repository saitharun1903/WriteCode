import { javaMainClass } from "../project/entry-points.js";
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
 * language command template. `{entryClass}` is the binary name of the class
 * with `main` in the entry file, read from its `package` declaration and
 * class declarations (not from the file's folder). Returns an argv array; nothing is ever passed
 * through a shell, so file names cannot inject commands.
 */
export function expandCommand(template: readonly string[], ctx: CommandContext): string[] {
  const out: string[] = [];
  let entryClass: string | undefined;
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
    if (arg.includes("{entryClass}")) {
      const file = ctx.files.find((f) => f.path === ctx.entry);
      entryClass ??= file ? javaMainClass(file) : stripExtension(ctx.entry.slice(ctx.entry.lastIndexOf("/") + 1));
    }
    out.push(arg.replaceAll("{entryClass}", entryClass ?? "").replaceAll("{entry}", ctx.entry));
  }
  return out;
}
