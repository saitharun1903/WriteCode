"use client";

import { create } from "zustand";

interface PreviewState {
  /** The preview is showing (beside the code, or over it on a phone). */
  open: boolean;
  /** It fills the window, like a browser opened inside an app. */
  full: boolean;
  /** Counts the presses of Run and Reload: each one loads the page afresh. */
  runs: number;
  /** The pages reached by following links in the preview, the current one last. Empty: the page in the editor. */
  trail: string[];
  /** Run: shows the preview and loads the page afresh, from the page in the editor. */
  run: () => void;
  reload: () => void;
  /** A link in the page was followed, or a page was chosen. */
  go: (page: string) => void;
  back: () => void;
  close: () => void;
  setFull: (full: boolean) => void;
}

/** The preview of a project that runs in the browser (HTML, CSS and JavaScript). */
export const usePreview = create<PreviewState>((set) => ({
  open: true,
  full: false,
  runs: 0,
  trail: [],
  run: () => set((s) => ({ open: true, runs: s.runs + 1, trail: [] })),
  reload: () => set((s) => ({ runs: s.runs + 1 })),
  go: (page) => set((s) => ({ trail: [...s.trail, page] })),
  back: () => set((s) => ({ trail: s.trail.slice(0, -1) })),
  close: () => set({ open: false, full: false }),
  setFull: (full) => set({ full }),
}));
