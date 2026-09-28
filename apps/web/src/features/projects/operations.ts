import {
  basename,
  getLanguage,
  isWithin,
  joinPath,
  parentOf,
  rebase,
  requireLanguage,
  validateName,
  type Project,
  type ProjectSummary,
} from "@cw/shared";

/**
 * Pure, immutable project transformations. The store calls these and then
 * persists the result, which keeps all file-system rules testable in isolation.
 */

export class ProjectOperationError extends Error {}

export function createProject(id: string, name: string, languageId: string, now = Date.now()): Project {
  const lang = requireLanguage(languageId);
  return {
    id,
    name: name.trim() || `${lang.name} project`,
    language: lang.id,
    entryFile: lang.entryFile,
    files: lang.template.map((f) => ({ ...f })),
    folders: [],
    stdin: "",
    createdAt: now,
    updatedAt: now,
  };
}

/** True when the project's files and folders are exactly its language's starter template. */
export function matchesTemplate(p: Project): boolean {
  const template = getLanguage(p.language)?.template;
  if (!template || p.folders.length > 0 || p.files.length !== template.length) return false;
  return template.every((t) => p.files.some((f) => f.path === t.path && f.content === t.content));
}

export function summarize(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    language: p.language,
    fileCount: p.files.length,
    updatedAt: p.updatedAt,
    lastRunAt: p.lastRunAt,
    // An example counts as untouched until anything in it changes.
    untouched: !p.lastRunAt && (p.example ? p.updatedAt === p.createdAt : !p.tests?.length && matchesTemplate(p)),
  };
}

/** Most recent activity: an edit or a run. Recent projects are ordered by it. */
export function lastActivity(p: Pick<ProjectSummary, "updatedAt" | "lastRunAt">): number {
  return Math.max(p.updatedAt, p.lastRunAt ?? 0);
}

function pathExists(p: Project, path: string): boolean {
  return p.files.some((f) => f.path === path) || p.folders.includes(path) || p.files.some((f) => isWithin(f.path, path) && f.path !== path);
}

function touch(p: Project, patch: Partial<Project>): Project {
  return { ...p, ...patch, updatedAt: Date.now() };
}

function assertName(name: string) {
  const err = validateName(name);
  if (err) throw new ProjectOperationError(err);
}

export function addFile(p: Project, dir: string, name: string, content = ""): { project: Project; path: string } {
  assertName(name);
  const path = joinPath(dir, name);
  if (pathExists(p, path)) throw new ProjectOperationError(`"${path}" already exists.`);
  return { project: touch(p, { files: [...p.files, { path, content }] }), path };
}

export function addFolder(p: Project, dir: string, name: string): { project: Project; path: string } {
  assertName(name);
  const path = joinPath(dir, name);
  if (pathExists(p, path)) throw new ProjectOperationError(`"${path}" already exists.`);
  return { project: touch(p, { folders: [...p.folders, path] }), path };
}

export function updateFileContent(p: Project, path: string, content: string): Project {
  let changed = false;
  const files = p.files.map((f) => {
    if (f.path !== path || f.content === content) return f;
    changed = true;
    return { ...f, content };
  });
  return changed ? touch(p, { files }) : p;
}

/** Renames a file or folder in place (same parent). Returns the new path. */
export function renamePath(p: Project, from: string, newName: string): { project: Project; path: string } {
  assertName(newName);
  const to = joinPath(parentOf(from), newName);
  if (to === from) return { project: p, path: from };
  if (pathExists(p, to)) throw new ProjectOperationError(`"${to}" already exists.`);
  return movePath(p, from, to);
}

/** Moves a file or folder to a new full path, rewriting descendants. */
export function movePath(p: Project, from: string, to: string): { project: Project; path: string } {
  if (isWithin(to, from) && to !== from) throw new ProjectOperationError("Cannot move a folder into itself.");
  if (to !== from && pathExists(p, to)) throw new ProjectOperationError(`"${to}" already exists.`);
  const files = p.files.map((f) => (isWithin(f.path, from) ? { ...f, path: rebase(f.path, from, to) } : f));
  const folders = p.folders.map((d) => rebase(d, from, to));
  const entryFile = rebase(p.entryFile, from, to);
  const breakpoints = mapBreakpointKeys(p.breakpoints, (file) => rebase(file, from, to));
  return { project: touch(p, { files, folders, entryFile, breakpoints }), path: to };
}

export function deletePath(p: Project, path: string): Project {
  const files = p.files.filter((f) => !isWithin(f.path, path));
  const folders = p.folders.filter((d) => !isWithin(d, path));
  let entryFile = p.entryFile;
  if (isWithin(entryFile, path)) entryFile = files[0]?.path ?? "";
  const breakpoints = mapBreakpointKeys(p.breakpoints, (file) => (isWithin(file, path) ? null : file));
  return touch(p, { files, folders, entryFile, breakpoints });
}

function mapBreakpointKeys(
  bps: Project["breakpoints"],
  fn: (file: string) => string | null,
): Project["breakpoints"] {
  if (!bps) return bps;
  const out: Record<string, number[]> = {};
  for (const [file, lines] of Object.entries(bps)) {
    const next = fn(file);
    if (next && lines.length) out[next] = lines;
  }
  return out;
}

export function breakpointsFor(p: Project, file: string): number[] {
  return p.breakpoints?.[file] ?? [];
}

/** Adds or removes a breakpoint on a line. */
export function toggleBreakpoint(p: Project, file: string, line: number): Project {
  const current = breakpointsFor(p, file);
  const lines = current.includes(line) ? current.filter((l) => l !== line) : [...current, line].sort((a, b) => a - b);
  return setBreakpoints(p, file, lines);
}

/** Replaces a file's breakpoints (used when edits move lines). */
export function setBreakpoints(p: Project, file: string, lines: number[]): Project {
  const unique = [...new Set(lines)].filter((l) => l >= 1).sort((a, b) => a - b);
  const current = breakpointsFor(p, file);
  if (unique.length === current.length && unique.every((l, i) => l === current[i])) return p;
  const breakpoints = { ...p.breakpoints };
  if (unique.length) breakpoints[file] = unique;
  else delete breakpoints[file];
  return touch(p, { breakpoints });
}

export function duplicateProject(p: Project, id: string, existingNames: readonly string[]): Project {
  let name = `${p.name} copy`;
  for (let i = 2; existingNames.includes(name); i++) name = `${p.name} copy ${i}`;
  const now = Date.now();
  return { ...structuredClone(p), id, name, createdAt: now, updatedAt: now };
}

/** Suggests a unique file name in `dir`, e.g. `Untitled.java`, `Untitled2.java`. */
export function uniqueName(p: Project, dir: string, stem: string, ext: string): string {
  for (let i = 1; ; i++) {
    const name = `${stem}${i === 1 ? "" : i}${ext}`;
    if (!pathExists(p, joinPath(dir, name))) return name;
  }
}

export { basename };
