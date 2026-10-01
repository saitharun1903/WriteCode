"use client";

import { create } from "zustand";
import type { Trace } from "@cw/shared";
import { logicStart, ranLine, withSourceTypeNames } from "./model";

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** Milliseconds per step while playing at 1×. */
export const BASE_STEP_MS = 800;

interface VisualizeState {
  /** Execution the trace belongs to; a new visualize run replaces it. */
  executionId: string | null;
  trace: Trace | null;
  step: number;
  playing: boolean;
  speed: Speed;
  /**
   * The step where the program's own logic starts (see `logicStart`). The steps
   * before it only prepare the data: they are left out unless `showSetup` is on.
   */
  start: number;
  showSetup: boolean;
  setShowSetup: (show: boolean) => void;
  setTrace: (executionId: string, trace: Trace) => void;
  clear: () => void;
  go: (step: number) => void;
  next: () => void;
  prev: () => void;
  /** Starts playback (from the beginning when at the last step) or pauses it. */
  togglePlay: () => void;
  pause: () => void;
  setSpeed: (speed: Speed) => void;
}

export const useVisualize = create<VisualizeState>((set, get) => ({
  executionId: null,
  trace: null,
  step: 0,
  playing: false,
  speed: 1,
  start: 0,
  showSetup: false,
  setTrace: (executionId, trace) => {
    const named = withSourceTypeNames(trace);
    let start = 0;
    try {
      start = logicStart(named);
    } catch {}
    set({ executionId, trace: named, start, showSetup: false, step: start, playing: false });
  },
  clear: () => set({ executionId: null, trace: null, step: 0, start: 0, showSetup: false, playing: false }),
  go: (step) => {
    const n = get().trace?.steps.length ?? 0;
    if (n > 0) set({ step: Math.max(firstStep(get()), Math.min(n - 1, step)) });
  },
  // Shown: from the very first step. Hidden again: back to where the logic starts.
  setShowSetup: (showSetup) => set((s) => ({ showSetup, playing: false, step: showSetup ? 0 : Math.max(s.step, s.start) })),
  next: () => get().go(get().step + 1),
  prev: () => get().go(get().step - 1),
  togglePlay: () => {
    const { playing, trace, step } = get();
    if (playing) return set({ playing: false });
    const last = (trace?.steps.length ?? 1) - 1;
    set({ playing: true, step: step >= last ? firstStep(get()) : step });
  },
  pause: () => set({ playing: false }),
  setSpeed: (speed) => set({ speed }),
}));

/** The first step that is shown. */
export const firstStep = (s: Pick<VisualizeState, "start" | "showSetup">) => (s.showSetup ? 0 : s.start);

/** Where the current step is: its innermost frame. */
export function stepLocation(s: Pick<VisualizeState, "trace" | "step">): { file: string; line: number } | null {
  const frames = s.trace?.steps[s.step]?.frames;
  const top = frames?.[frames.length - 1];
  return top?.file ? { file: top.file, line: top.line } : null;
}

/** The line that ran to reach the current step. */
export function previousLocation(s: Pick<VisualizeState, "trace" | "step">): { file: string; line: number } | null {
  const prev = s.step > 0 ? s.trace?.steps[s.step - 1] : undefined;
  return prev ? ranLine(prev) : null;
}
