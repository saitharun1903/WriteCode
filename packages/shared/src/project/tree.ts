import { isSafeRelativePath } from "../execution/validate.js";
import type { ProjectFile } from "./types.js";

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "folder";
  children: TreeNode[];
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Validates a single file or folder name typed by the user. Returns an error message or null. */
export function validateName(name: string): string | null {
  if (!name.trim()) return "Name cannot be empty.";
  if (name.includes("/") || name.includes("\\")) return "Name cannot contain slashes.";
  if (!isSafeRelativePath(name)) return "Use letters, digits, '.', '-' or '_' (no leading dot).";
  return null;
}

/** Builds a sorted tree (folders first, then alphabetical) from flat files and folders. */
export function buildTree(files: readonly ProjectFile[], folders: readonly string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", kind: "folder", children: [] };
  const index = new Map<string, TreeNode>([["", root]]);

  const ensureFolder = (path: string): TreeNode => {
    const existing = index.get(path);
    if (existing) return existing;
    const node: TreeNode = { name: basename(path), path, kind: "folder", children: [] };
    index.set(path, node);
    ensureFolder(parentOf(path)).children.push(node);
    return node;
  };

  for (const folder of folders) ensureFolder(folder);
  for (const file of files) {
    ensureFolder(parentOf(file.path)).children.push({ name: basename(file.path), path: file.path, kind: "file", children: [] });
  }

  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** Returns true when `path` is `prefix` or lives inside it. */
export function isWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** Rewrites `path` when its ancestor `from` is renamed/moved to `to`. */
export function rebase(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}
