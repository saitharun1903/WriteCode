"use client";

import { create } from "zustand";

/**
 * A candidate in an interview has the editor, Run on the example tests and
 * Submit only: no debugger, visualizer or AI, no other projects, no files
 * brought in from outside. Every command, button and shortcut goes through
 * the command registry, which asks here. (The server also refuses a
 * candidate's debug and visualize runs and logs the attempt.)
 */
export const useRestriction = create<{ restricted: boolean }>(() => ({ restricted: false }));

export const isRestricted = () => useRestriction.getState().restricted;

const BLOCKED =
  /^(debug\.|assistant\.|tests\.|project\.|workbench\.|interview\.|run\.(visualize|currentFile|clearOutput)$|file\.(import|importFolder|newFile|newFolder|setEntry|closeTab|save|downloadPdf|shareLink)$|view\.)/;

/** True when `commandId` is a tool the candidate may not use. */
export function blockedForCandidate(commandId: string): boolean {
  return isRestricted() && BLOCKED.test(commandId);
}
