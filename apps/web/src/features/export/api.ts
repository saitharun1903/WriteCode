"use client";

import { create } from "zustand";
import { SHARE_LIMITS, type Project, type SharedCode } from "@cw/shared";
import { API_URL } from "@/features/execution/api";
import { projectRepo } from "@/features/projects/db";
import { useWorkspace } from "@/features/projects/store";

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("The server could not be reached. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as T & { message?: string | string[] };
  if (!res.ok) throw new Error(Array.isArray(data.message) ? data.message.join(", ") : (data.message ?? `Request failed (${res.status})`));
  return data;
}

/** Shares a read-only copy of the project's files; resolves with the link. */
export async function createShare(project: Pick<Project, "name" | "language" | "entryFile" | "files">): Promise<string> {
  const { id } = await post<{ id: string }>("shares", { name: project.name, language: project.language, entryFile: project.entryFile, files: project.files.map((f) => ({ path: f.path, content: f.content })) });
  return `${location.origin}/share#${id}`;
}

export const openShare = (id: string) => post<SharedCode>("shares/open", { id });

/** What of a project moves to another browser: the work, not this browser's breakpoints or interviews. */
const portable = (p: Project) => ({ id: p.id, name: p.name, language: p.language, entryFile: p.entryFile, files: p.files, folders: p.folders, stdin: p.stdin, tests: p.tests, createdAt: p.createdAt, updatedAt: p.updatedAt, lastRunAt: p.lastRunAt });

/**
 * Puts projects aside on the server for another browser to collect. The most
 * recently used come first; those that do not fit in one transfer are left
 * out and named in `left`.
 */
export async function createTransfer(projects: Project[]): Promise<{ link: string; sent: Project[]; left: Project[]; expiresAt: number }> {
  // The most recently used first: they are the ones wanted on the other device.
  projects = [...projects].sort((a, b) => Math.max(b.updatedAt, b.lastRunAt ?? 0) - Math.max(a.updatedAt, a.lastRunAt ?? 0));
  const sent: Project[] = [];
  const left: Project[] = [];
  let size = 2;
  for (const p of projects) {
    const bytes = JSON.stringify(portable(p)).length + 1;
    if (sent.length < SHARE_LIMITS.transferMaxProjects && size + bytes <= SHARE_LIMITS.transferMaxBytes - 4096) {
      sent.push(p);
      size += bytes;
    } else left.push(p);
  }
  if (!sent.length) throw new Error("These projects are too large to move this way.");
  const { id, expiresInSeconds } = await post<{ id: string; expiresInSeconds: number }>("transfers", { projects: sent.map(portable) });
  return { link: `${location.origin}/get#${id}`, sent, left, expiresAt: Date.now() + expiresInSeconds * 1000 };
}

export const openTransfer = (id: string) => post<{ projects: Project[] }>("transfers/open", { id });

export interface Transfer {
  link: string;
  sent: Project[];
  left: Project[];
  expiresAt: number;
}

interface ExportState {
  dialog: "share" | "transfer" | "download" | null;
  /** The link being made for the open dialog. Started when the dialog opens, once. */
  share: Promise<string> | null;
  transfer: Promise<Transfer> | null;
  open: (dialog: "share" | "transfer" | "download") => void;
  /** A fresh code after the last one expired. */
  renewTransfer: () => void;
  close: () => void;
}

/** Everything in this browser worth moving: projects that were changed or run. Interviews stay with the browser that gave them. */
async function startTransfer(): Promise<Transfer> {
  const ws = useWorkspace.getState();
  await ws.flush();
  const wanted = useWorkspace.getState().projects.filter((p) => !p.untouched && !p.interview);
  const projects = (await Promise.all(wanted.map((p) => projectRepo.get(p.id)))).filter((p): p is Project => !!p);
  if (!projects.length) throw new Error("There are no projects to move yet. Projects appear here once you have changed or run them.");
  return createTransfer(projects);
}

/** Never left unhandled: the dialog shows the reason. */
const quiet = <T,>(p: Promise<T>): Promise<T> => {
  p.catch(() => {});
  return p;
};

/** Which export dialog is open, and the link it is for. */
export const useExport = create<ExportState>((set) => ({
  dialog: null,
  share: null,
  transfer: null,
  open: (dialog) => {
    const project = useWorkspace.getState().project;
    if (dialog === "download") set({ dialog });
    else if (dialog === "share") set({ dialog, share: project ? quiet(createShare(project)) : null });
    else set({ dialog, transfer: quiet(startTransfer()) });
  },
  renewTransfer: () => set({ transfer: quiet(startTransfer()) }),
  close: () => set({ dialog: null, share: null, transfer: null }),
}));
