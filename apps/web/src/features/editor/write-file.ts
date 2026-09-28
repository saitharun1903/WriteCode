"use client";

import { useWorkspace } from "@/features/projects/store";
import { editorBridge } from "./bridge";

/** Opens `path` in the editor and waits (up to about a second) until it is the active model. */
export async function showFile(path: string): Promise<boolean> {
  if (editorBridge.currentPath() === path) return true;
  useWorkspace.getState().openFile(path);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    if (editorBridge.currentPath() === path) return true;
  }
  return false;
}

/**
 * Writes new content through the editor when possible: one undoable change
 * covering only the lines that differ, briefly highlighted. Falls back to
 * updating the saved file directly.
 */
export async function writeFile(path: string, content: string) {
  if (!(await showFile(path)) || !editorBridge.applyContent(content)) useWorkspace.getState().updateFile(path, content);
}
