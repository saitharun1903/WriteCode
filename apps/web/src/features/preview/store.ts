"use client";

import { create } from "zustand";

interface PreviewState {
  /** Counts the presses of Run: each one loads the page afresh. */
  runs: number;
  /** The page shown, when it is not the one in the editor (a link in the preview was followed). */
  page: string | null;
  run: () => void;
  setPage: (page: string | null) => void;
}

/** The preview of a project that runs in the browser (HTML, CSS and JavaScript). */
export const usePreview = create<PreviewState>((set) => ({
  runs: 0,
  page: null,
  run: () => set((s) => ({ runs: s.runs + 1, page: null })),
  setPage: (page) => set({ page }),
}));
