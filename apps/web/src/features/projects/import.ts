import { REQUEST_BOUNDS, isSafeRelativePath, type Project } from "@cw/shared";

/**
 * Importing files from the user's computer. `planImport` decides, without
 * touching anything, what would be added, what would replace an existing
 * file and what is skipped (with the reason), so the user can review it first.
 */
export interface IncomingFile {
  /** Path as picked or dropped, e.g. "src/Main.java" or "My Folder/notes.txt". */
  path: string;
  bytes: Uint8Array;
}

export interface PlannedFile {
  path: string;
  content: string;
  /** An existing project file with this path would be overwritten. */
  replaces: boolean;
  /** The name was changed to one the sandbox accepts (spaces and symbols become _). */
  renamedFrom?: string;
}

export interface ImportPlan {
  files: PlannedFile[];
  skipped: { path: string; reason: string }[];
}

/** Folders that are build output, dependencies or tooling, never source. */
const IGNORED_DIRS = new Set(["node_modules", "__pycache__", "target", "build", "out", "bin", "obj", "dist", "venv"]);
const BINARY_EXT = /\.(class|jar|o|obj|exe|dll|so|dylib|pyc|png|jpe?g|gif|bmp|ico|webp|pdf|zip|gz|tar|7z|rar|mp3|mp4|mov|woff2?|ttf|docx?|xlsx?|pptx?)$/i;

/** A path the sandbox accepts: spaces and other symbols in each segment become underscores. */
export function safePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== ".")
    .map((s) => s.replace(/[^A-Za-z0-9_.-]+/g, "_"))
    .join("/");
}

function decode(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    // TextDecoder drops a leading byte-order mark by itself.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}

export function planImport(project: Project, incoming: readonly IncomingFile[]): ImportPlan {
  const files: PlannedFile[] = [];
  const skipped: ImportPlan["skipped"] = [];
  const existing = new Set(project.files.map((f) => f.path));
  let room = REQUEST_BOUNDS.maxFiles - project.files.length;
  const seen = new Set<string>();

  for (const item of [...incoming].sort((a, b) => a.path.localeCompare(b.path))) {
    const original = item.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = original.split("/");
    if (segments.some((s) => s.startsWith(".") || IGNORED_DIRS.has(s))) {
      skipped.push({ path: original, reason: segments.some((s) => s.startsWith(".")) ? "hidden file" : "build or tool folder" });
      continue;
    }
    if (BINARY_EXT.test(original)) {
      skipped.push({ path: original, reason: "not a text file" });
      continue;
    }
    if (item.bytes.length > REQUEST_BOUNDS.maxFileBytes) {
      skipped.push({ path: original, reason: `larger than ${REQUEST_BOUNDS.maxFileBytes / 1024} KB` });
      continue;
    }
    const content = decode(item.bytes);
    if (content === null) {
      skipped.push({ path: original, reason: "not a text file" });
      continue;
    }
    const path = safePath(original);
    if (!isSafeRelativePath(path)) {
      skipped.push({ path: original, reason: "name can't be used" });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ path: original, reason: "same name as another imported file" });
      continue;
    }
    const replaces = existing.has(path);
    if (!replaces && room <= 0) {
      skipped.push({ path: original, reason: `projects hold up to ${REQUEST_BOUNDS.maxFiles} files` });
      continue;
    }
    if (!replaces) room--;
    seen.add(path);
    files.push({ path, content, replaces, ...(path !== original ? { renamedFrom: original } : {}) });
  }
  return { files, skipped };
}

/** Adds the planned files, replacing existing ones with the same path. */
export function applyImport(project: Project, files: readonly PlannedFile[]): Project {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const kept = project.files.map((f) => (byPath.has(f.path) ? { ...f, content: byPath.get(f.path)! } : f));
  const added = files.filter((f) => !f.replaces).map((f) => ({ path: f.path, content: f.content }));
  return { ...project, files: [...kept, ...added], updatedAt: Date.now() };
}

// ---- Browser side: reading picked and dropped files.

/** Files chosen with an <input type="file"> (a folder pick keeps each file's relative path). */
export async function readPicked(list: FileList): Promise<IncomingFile[]> {
  return Promise.all(
    [...list].map(async (file) => ({
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

async function walk(entry: FileSystemEntry, out: IncomingFile[], limit: number): Promise<void> {
  if (out.length >= limit) return;
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push({ path: entry.fullPath.replace(/^\//, ""), bytes: new Uint8Array(await file.arrayBuffer()) });
    return;
  }
  if (!entry.isDirectory || IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns batches until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    for (const child of batch) await walk(child, out, limit);
  }
}

/** Files and folders dropped from the desktop, folders read recursively (skipping build and tool folders). */
export async function readDropped(data: DataTransfer): Promise<IncomingFile[]> {
  // Entries must be taken synchronously, before the drop event ends.
  const entries = [...data.items].map((i) => (i.kind === "file" ? i.webkitGetAsEntry() : null)).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return readPicked(data.files);
  const out: IncomingFile[] = [];
  // A generous cap so a dropped home folder cannot hang the tab; the plan enforces the real limit.
  for (const e of entries) await walk(e, out, 500);
  return out;
}
