"use client";

import { create } from "zustand";

/**
 * A candidate in an interview has the editor, Run and the sample tests only:
 * no debugger, visualizer or AI. Every command, button and shortcut goes
 * through the command registry, which asks here. (The server also refuses a
 * candidate's debug and visualize runs and logs the attempt.)
 */
export const useRestriction = create<{ restricted: boolean }>(() => ({ restricted: false }));

export const isRestricted = () => useRestriction.getState().restricted;

const BLOCKED = /^(debug\.|assistant\.|run\.visualize$)/;

/** True when `commandId` is a tool the candidate may not use. */
export function blockedForCandidate(commandId: string): boolean {
  return isRestricted() && BLOCKED.test(commandId);
}
