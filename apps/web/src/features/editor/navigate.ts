"use client";

import { useWorkspace } from "@/features/projects/store";
import { editorBridge } from "./bridge";

/** Opens `file` (if needed) and places the cursor at `line`/`column`. */
export function goToLocation(file: string, line: number, column = 1) {
  const ws = useWorkspace.getState();
  if (!ws.project?.files.some((f) => f.path === file)) return;
  if (ws.activeFile === file) {
    editorBridge.reveal(line, column);
  } else {
    editorBridge.revealAfterSwitch(line, column);
    ws.openFile(file);
  }
}

/** Shows `line` of `file` (opening it if needed) without moving the cursor or taking focus. */
export function showLocation(file: string, line: number) {
  const ws = useWorkspace.getState();
  if (!ws.project?.files.some((f) => f.path === file)) return;
  if (ws.activeFile === file) {
    editorBridge.showLine(line);
  } else {
    editorBridge.revealAfterSwitch(line, 1, false);
    ws.openFile(file);
  }
}
