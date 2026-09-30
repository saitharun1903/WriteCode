"use client";

import { create } from "zustand";

/** Which interview dialogs are open. */
export const useInterviewUI = create<{
  setup: "create" | "edit" | null;
  replayOpen: boolean;
  openSetup: (mode: "create" | "edit") => void;
  closeSetup: () => void;
  setReplayOpen: (open: boolean) => void;
}>((set) => ({
  setup: null,
  replayOpen: false,
  openSetup: (mode) => set({ setup: mode }),
  closeSetup: () => set({ setup: null }),
  setReplayOpen: (replayOpen) => set({ replayOpen }),
}));
