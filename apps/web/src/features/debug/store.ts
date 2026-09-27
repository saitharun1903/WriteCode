"use client";

import { create } from "zustand";
import type { DebugCommand, DebugEvent, DebugFrame, DebugVariable, StopReason } from "@cw/shared";
import { sendDebugCommand } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { createId } from "@/lib/id";

export type DebugPhase = "starting" | "running" | "paused" | "ended";

export interface StopInfo {
  reason: StopReason;
  thread: string;
  description?: string;
  frames: DebugFrame[];
}

export type VariablesState = { status: "loading" } | { status: "ready"; variables: DebugVariable[] } | { status: "error"; message: string };
export type WatchState = { status: "loading" } | { status: "ready"; value: string; type: string; ref: number } | { status: "error"; message: string };

type ResponseEvent = Extract<DebugEvent, { kind: "response" }>;

interface DebugState {
  executionId: string | null;
  phase: DebugPhase | null;
  stop: StopInfo | null;
  selectedFrame: number;
  /** Children by variables reference; valid only for the current pause. */
  variables: Record<number, VariablesState>;
  watches: string[];
  watchResults: Record<string, WatchState>;
  /** Per file: lines the adapter could not place a breakpoint on. */
  unverified: Record<string, number[]>;
  /**
   * Values of the paused frame's variables at the previous pause, so the UI can
   * show what the program changed since. `frame` identifies the frame (method
   * and stack depth); values are only compared within the same frame.
   */
  previous: { frame: string; values: Record<string, string> } | null;

  onStarted: (executionId: string) => void;
  onEvent: (event: DebugEvent) => void;
  onEnded: () => void;
  onCommandError: (requestId: string, message: string) => void;

  command: (cmd: "continue" | "pause" | "stepOver" | "stepIn" | "stepOut") => void;
  selectFrame: (index: number) => void;
  loadVariables: (ref: number) => void;
  syncBreakpoints: (file: string) => void;
  setWatches: (projectId: string) => void;
  addWatch: (expression: string) => void;
  removeWatch: (expression: string) => void;
  refreshWatches: () => void;
}

const pending = new Map<string, (event: ResponseEvent | { kind: "error"; message: string }) => void>();
const watchKey = (projectId: string) => `cw:watches:${projectId}`;

function request(command: DebugCommand): Promise<ResponseEvent | { kind: "error"; message: string }> {
  const requestId = createId().slice(0, 12);
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    if (!sendDebugCommand(requestId, command)) {
      pending.delete(requestId);
      resolve({ kind: "error", message: "Not connected to the debug session." });
    }
    // Never leave the UI waiting forever on a lost response.
    setTimeout(() => {
      if (pending.delete(requestId)) resolve({ kind: "error", message: "The debugger did not respond." });
    }, 10_000);
  });
}

function persistWatches(watches: string[]) {
  const projectId = useWorkspace.getState().project?.id;
  if (!projectId) return;
  try {
    localStorage.setItem(watchKey(projectId), JSON.stringify(watches));
  } catch {}
}

export const useDebug = create<DebugState>((set, get) => ({
  executionId: null,
  phase: null,
  stop: null,
  selectedFrame: 0,
  variables: {},
  watches: [],
  watchResults: {},
  unverified: {},
  previous: null,

  onStarted(executionId) {
    pending.clear();
    set({ executionId, phase: "starting", stop: null, selectedFrame: 0, variables: {}, watchResults: {}, unverified: {}, previous: null });
  },

  onEvent(event) {
    switch (event.kind) {
      case "stopped": {
        // Prefer the innermost frame inside the project so JDK frames are not selected by default.
        const firstOwn = Math.max(0, event.frames.findIndex((f) => f.file));
        set({
          phase: "paused",
          stop: { reason: event.reason, thread: event.thread, description: event.description, frames: event.frames },
          selectedFrame: firstOwn,
          variables: {},
        });
        const frame = event.frames[firstOwn];
        if (frame?.localsRef) get().loadVariables(frame.localsRef);
        get().refreshWatches();
        break;
      }
      case "continued": {
        const { stop, selectedFrame, variables } = get();
        const frame = stop?.frames[selectedFrame];
        const locals = frame ? variables[frame.localsRef] : undefined;
        const previous =
          frame && stop && locals?.status === "ready"
            ? { frame: frameKey(stop.frames, selectedFrame), values: Object.fromEntries(locals.variables.map((v) => [v.name, v.value])) }
            : get().previous;
        set({ phase: "running", stop: null, variables: {}, previous });
        break;
      }
      case "breakpoints":
        set((s) => ({
          unverified: { ...s.unverified, [event.file]: event.breakpoints.filter((b) => !b.verified).map((b) => b.line) },
        }));
        break;
      case "response": {
        const resolve = pending.get(event.requestId);
        if (resolve) {
          pending.delete(event.requestId);
          resolve(event);
        }
        break;
      }
    }
  },

  onEnded() {
    for (const resolve of pending.values()) resolve({ kind: "error", message: "The debug session has ended." });
    pending.clear();
    set({ phase: "ended", stop: null, variables: {} });
  },

  onCommandError(requestId, message) {
    const resolve = pending.get(requestId);
    if (resolve) {
      pending.delete(requestId);
      resolve({ kind: "error", message });
    }
  },

  command(cmd) {
    const { phase } = get();
    if (cmd === "pause" ? phase !== "running" : phase !== "paused") return;
    void request({ cmd });
  },

  selectFrame(index) {
    const frame = get().stop?.frames[index];
    if (!frame) return;
    set({ selectedFrame: index });
    if (frame.localsRef && !get().variables[frame.localsRef]) get().loadVariables(frame.localsRef);
    get().refreshWatches();
  },

  loadVariables(ref) {
    if (get().phase !== "paused") return;
    set((s) => ({ variables: { ...s.variables, [ref]: { status: "loading" } } }));
    void request({ cmd: "variables", ref }).then((res) => {
      let state: VariablesState;
      if (res.kind === "error") state = { status: "error", message: res.message };
      else if (!res.success) state = { status: "error", message: res.message ?? "Could not read variables." };
      else state = { status: "ready", variables: res.variables ?? [] };
      set((s) => (s.variables[ref] ? { variables: { ...s.variables, [ref]: state } } : s));
    });
  },

  syncBreakpoints(file) {
    const { phase } = get();
    if (phase !== "running" && phase !== "paused") return;
    const lines = useWorkspace.getState().project?.breakpoints?.[file] ?? [];
    void request({ cmd: "setBreakpoints", file, lines });
  },

  setWatches(projectId) {
    let watches: string[] = [];
    try {
      const raw = localStorage.getItem(watchKey(projectId));
      if (raw) watches = (JSON.parse(raw) as unknown[]).filter((w): w is string => typeof w === "string").slice(0, 50);
    } catch {}
    set({ watches, watchResults: {} });
  },

  addWatch(expression) {
    const expr = expression.trim();
    if (!expr || get().watches.includes(expr)) return;
    const watches = [...get().watches, expr];
    set({ watches });
    persistWatches(watches);
    get().refreshWatches();
  },

  removeWatch(expression) {
    const watches = get().watches.filter((w) => w !== expression);
    set((s) => {
      const watchResults = { ...s.watchResults };
      delete watchResults[expression];
      return { watches, watchResults };
    });
    persistWatches(watches);
  },

  refreshWatches() {
    const { phase, watches, selectedFrame } = get();
    if (phase !== "paused" || watches.length === 0) return;
    const loading: Record<string, WatchState> = {};
    for (const w of watches) loading[w] = { status: "loading" };
    set({ watchResults: loading });
    for (const expression of watches) {
      void request({ cmd: "evaluate", expression, frame: selectedFrame }).then((res) => {
        let state: WatchState;
        if (res.kind === "error") state = { status: "error", message: res.message };
        else if (res.error) state = { status: "error", message: res.error };
        else if (!res.success || !res.result) state = { status: "error", message: res.message ?? "Could not evaluate." };
        else state = { status: "ready", value: res.result.value, type: res.result.type, ref: res.result.ref };
        set((s) => (s.watches.includes(expression) ? { watchResults: { ...s.watchResults, [expression]: state } } : s));
      });
    }
  },
}));

/** Identifies a frame across pauses: its method and how deep it is in the stack. */
export function frameKey(frames: DebugFrame[], index: number): string {
  return `${frames[index]?.name ?? ""}#${frames.length - index}`;
}

/** Location the program is paused at (selected frame), if any. */
export function currentLocation(s: Pick<DebugState, "stop" | "selectedFrame">): { file: string; line: number; top: boolean } | null {
  const frame = s.stop?.frames[s.selectedFrame];
  if (!frame?.file) return null;
  return { file: frame.file, line: frame.line, top: s.selectedFrame === 0 };
}
