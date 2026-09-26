"use client";

import { create } from "zustand";

export type PaletteMode = "commands" | "files" | "projects";

/** Transient UI state that is not persisted: dialogs, palette, inline edits. */
interface UIState {
  palette: { open: boolean; mode: PaletteMode };
  newProjectOpen: boolean;
  settingsOpen: boolean;
  /** Explorer inline creation request, e.g. from the command palette. */
  pendingCreate: { dir: string; kind: "file" | "folder" } | null;
  /** Mobile/compact drawers. */
  drawer: "none" | "sidebar" | "bottom" | "debug";

  openPalette: (mode: PaletteMode) => void;
  closePalette: () => void;
  setNewProjectOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  requestCreate: (dir: string, kind: "file" | "folder") => void;
  clearPendingCreate: () => void;
  setDrawer: (drawer: UIState["drawer"]) => void;
}

export const useUI = create<UIState>((set) => ({
  palette: { open: false, mode: "commands" },
  newProjectOpen: false,
  settingsOpen: false,
  pendingCreate: null,
  drawer: "none",

  openPalette: (mode) => set({ palette: { open: true, mode } }),
  closePalette: () => set((s) => ({ palette: { ...s.palette, open: false } })),
  setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  requestCreate: (dir, kind) => set({ pendingCreate: { dir, kind } }),
  clearPendingCreate: () => set({ pendingCreate: null }),
  setDrawer: (drawer) => set({ drawer }),
}));
