"use client";

import { create } from "zustand";
import type { Trace } from "@cw/shared";

interface VisualizeState {
  /** Execution the trace belongs to; a new visualize run replaces it. */
  executionId: string | null;
  trace: Trace | null;
  step: number;
  setTrace: (executionId: string, trace: Trace) => void;
  clear: () => void;
  go: (step: number) => void;
  next: () => void;
  prev: () => void;
}

export const useVisualize = create<VisualizeState>((set, get) => ({
  executionId: null,
  trace: null,
  step: 0,
  setTrace: (executionId, trace) => set({ executionId, trace, step: 0 }),
  clear: () => set({ executionId: null, trace: null, step: 0 }),
  go: (step) => {
    const n = get().trace?.steps.length ?? 0;
    if (n > 0) set({ step: Math.max(0, Math.min(n - 1, step)) });
  },
  next: () => get().go(get().step + 1),
  prev: () => get().go(get().step - 1),
}));

/** Where the current step is: its innermost frame. */
export function stepLocation(s: Pick<VisualizeState, "trace" | "step">): { file: string; line: number } | null {
  const frames = s.trace?.steps[s.step]?.frames;
  const top = frames?.[frames.length - 1];
  return top?.file ? { file: top.file, line: top.line } : null;
}
