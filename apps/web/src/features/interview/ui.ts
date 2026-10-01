"use client";

import { create } from "zustand";

/** Which interview dialogs are open. */
export const useInterviewUI = create<{
  setup: "create" | "edit" | null;
  replayOpen: boolean;
  /** Interviewer: the interview has just finished; ask whether to save it. */
  savePrompt: boolean;
  setSavePrompt: (open: boolean) => void;
  openSetup: (mode: "create" | "edit") => void;
  closeSetup: () => void;
  setReplayOpen: (open: boolean) => void;
}>((set) => ({
  setup: null,
  replayOpen: false,
  savePrompt: false,
  setSavePrompt: (savePrompt) => set({ savePrompt }),
  openSetup: (mode) => set({ setup: mode }),
  closeSetup: () => set({ setup: null }),
  setReplayOpen: (replayOpen) => set({ replayOpen }),
}));
