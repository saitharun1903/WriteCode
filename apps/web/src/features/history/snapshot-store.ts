"use client";

import { create } from "zustand";
import type { ProjectFile, Snapshot } from "@cw/shared";
import { toast } from "@/components/ui/toast";
import { snapshotRepo } from "@/features/projects/db";
import { useWorkspace } from "@/features/projects/store";
import { createId } from "@/lib/id";

interface CompareTarget {
  title: string;
  /** Left side of the diff (the older version). */
  files: ProjectFile[];
}

interface SnapshotState {
  projectId: string | null;
  snapshots: Snapshot[];
  status: "idle" | "loading" | "ready" | "error";
  compare: CompareTarget | null;

  load: (projectId: string) => Promise<void>;
  create: (label?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Restores files after saving the current state as a snapshot, so a restore is always undoable. */
  restore: (snapshot: Pick<Snapshot, "files" | "label">) => Promise<void>;
  openCompare: (target: CompareTarget) => void;
  closeCompare: () => void;
}

export const useSnapshots = create<SnapshotState>((set, get) => ({
  projectId: null,
  snapshots: [],
  status: "idle",
  compare: null,

  async load(projectId) {
    set({ projectId, status: "loading" });
    try {
      const snapshots = await snapshotRepo.listByProject(projectId);
      if (get().projectId === projectId) set({ snapshots, status: "ready" });
    } catch {
      set({ status: "error" });
    }
  },

  async create(label) {
    const project = useWorkspace.getState().project;
    if (!project) return;
    if (project.temporary) return void toast.info("Temporary projects keep no snapshots", "Keep the project first, from the Temporary button at the top.");
    await useWorkspace.getState().flush();
    const existing = get().projectId === project.id ? get().snapshots : await snapshotRepo.listByProject(project.id);
    const snapshot: Snapshot = {
      id: createId(),
      projectId: project.id,
      label: label?.trim() || `Version ${existing.length + 1}`,
      files: structuredClone(project.files),
      createdAt: Date.now(),
    };
    try {
      await snapshotRepo.add(snapshot);
    } catch (e) {
      return void toast.error("Could not save snapshot", e instanceof Error ? e.message : undefined);
    }
    set({ projectId: project.id, snapshots: [snapshot, ...existing], status: "ready" });
    toast.success(`Saved ${snapshot.label}`);
  },

  async remove(id) {
    await snapshotRepo.delete(id);
    set({ snapshots: get().snapshots.filter((s) => s.id !== id) });
  },

  async restore(snapshot) {
    await get().create(`Before restoring ${snapshot.label}`);
    useWorkspace.getState().replaceFiles(snapshot.files);
    toast.success(`Restored ${snapshot.label}`);
  },

  openCompare: (compare) => set({ compare }),
  closeCompare: () => set({ compare: null }),
}));
