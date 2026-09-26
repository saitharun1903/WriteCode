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
