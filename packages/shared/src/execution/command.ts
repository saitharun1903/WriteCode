import type { LanguageDefinition } from "../languages/types.js";
import { findEntryPoints, javaMainClass, kotlinMainClass, classFilesUsed } from "../project/entry-points.js";
import type { SourceFile } from "./types.js";

export interface CommandContext {
  entry: string;
  files: SourceFile[];
  sourceExtensions?: string[];
  /** The files `{sources}` stands for; every source file of the project when not given. */
  sources?: string[];
}

function stripExtension(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(0, dot) : path;
}

function sourcesOf(ctx: CommandContext): string[] {
  const exts = ctx.sourceExtensions ?? [];
  return ctx.files
    .map((f) => f.path)
    .filter((p) => exts.some((ext) => p.toLowerCase().endsWith(ext)))
    .sort();
}

/** The project's folder and every folder under it that holds a source file, or leads to one. */
function sourceRoots(ctx: CommandContext): string {
  const roots = new Set<string>();
  for (const path of sourcesOf(ctx)) {
    const parts = path.split("/").slice(0, -1);
    for (let k = 1; k <= parts.length; k++) roots.add(parts.slice(0, k).join("/"));
  }
  return [".", ...[...roots].sort()].join(":");
}

/**
 * Expands `{entry}`, `{entryClass}`, `{sources}` and `{sourceRoots}`
 * placeholders in a language command template. `{entryClass}` is the binary
 * name of the class with `main` in the entry file, read from its `package`
 * declaration and class declarations (not from the file's folder); for a
 * Kotlin file, the class its top-level `main` is compiled into. Returns an
 * argv array; nothing is ever passed through a shell, so file names cannot
 * inject commands.
 */
export function expandCommand(template: readonly string[], ctx: CommandContext): string[] {
  const out: string[] = [];
  let entryClass: string | undefined;
  for (const arg of template) {
    if (arg === "{sources}") {
      out.push(...(ctx.sources ?? sourcesOf(ctx)));
      continue;
    }
    if (arg === "{sourceRoots}") {
      out.push(sourceRoots(ctx));
      continue;
    }
    if (arg.includes("{entryClass}")) {
      const file = ctx.files.find((f) => f.path === ctx.entry);
      // A Kotlin file's top-level functions are in a class named after the file.
      entryClass ??= file ? (/\.kts?$/i.test(file.path) ? kotlinMainClass(file) : javaMainClass(file)) : stripExtension(ctx.entry.slice(ctx.entry.lastIndexOf("/") + 1));
    }
    out.push(arg.replaceAll("{entryClass}", entryClass ?? "").replaceAll("{entry}", ctx.entry));
  }
  return out;
}

/** One way to build the program that starts in the entry file. */
export interface CompilePlan {
  argv: string[];
  /** The source files given to the compiler. */
  sources: string[];
}

/**
 * The ways to build the program in `entry`, to be tried in order until one
 * compiles; when none does, the first one's errors are the ones to show. Only
 * the file being run and what it needs is built, so a mistake in another
 * program of the same project does not stop this one:
 *
 * - `program` builds (everything is linked into one program) take the entry
 *   file with the files that have no main function of their own, and then the
 *   entry file alone in case one of those is broken and not needed.
 * - `classes` builds take the entry file and the files whose types it uses.
 *
 * An entry that is not a source file leaves the one build of everything.
 */
export function compilePlans(lang: LanguageDefinition, ctx: { entry: string; files: SourceFile[] }, template: readonly string[] = lang.compiler?.command ?? []): CompilePlan[] {
  const compiler = lang.compiler;
  if (!compiler) return [];
  const base: CommandContext = { entry: ctx.entry, files: ctx.files, sourceExtensions: compiler.sourceExtensions };
  const all = sourcesOf(base);
  const lists: string[][] = [];
  if (!all.includes(ctx.entry)) lists.push(all);
  else if (compiler.builds === "program") {
    const programs = new Set(findEntryPoints(lang.id, ctx.files).map((e) => e.file));
    lists.push(all.filter((p) => p === ctx.entry || !programs.has(p)), [ctx.entry]);
  } else {
    lists.push([ctx.entry, ...classFilesUsed(lang.id, ctx.entry, ctx.files)]);
  }
  const plans: CompilePlan[] = [];
  for (const sources of lists) {
    // (A compiler that is given only the entry file runs the same command whatever the list.)
    const argv = expandCommand(template, { ...base, sources });
    if (plans.some((p) => p.argv.join("\n") === argv.join("\n"))) continue;
    plans.push({ sources, argv });
  }
  return plans;
}
