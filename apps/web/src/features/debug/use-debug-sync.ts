"use client";

import { useEffect } from "react";
import { goToLocation } from "@/features/editor/navigate";
import { useWorkspace } from "@/features/projects/store";
import { currentLocation, useDebug } from "./store";

/**
 * Keeps the debugger and the workspace in step:
 * - reveals the paused line (switching files if needed),
 * - sends breakpoint edits to a live session,
 * - loads each project's saved watch expressions.
 */
export function useDebugSync() {
  useEffect(() => {
    const unsubStop = useDebug.subscribe((s, prev) => {
      if (s.stop === prev.stop && s.selectedFrame === prev.selectedFrame) return;
      const loc = currentLocation(s);
      if (loc) goToLocation(loc.file, loc.line);
    });

    const unsubBreakpoints = useWorkspace.subscribe((s, prev) => {
      const next = s.project?.breakpoints ?? {};
      const before = prev.project?.breakpoints ?? {};
      if (next === before || s.project?.id !== prev.project?.id) return;
      for (const file of new Set([...Object.keys(next), ...Object.keys(before)])) {
        if (next[file] !== before[file]) useDebug.getState().syncBreakpoints(file);
      }
    });

    const loadWatches = (projectId: string | undefined) => projectId && useDebug.getState().setWatches(projectId);
    loadWatches(useWorkspace.getState().project?.id);
    const unsubProject = useWorkspace.subscribe((s, prev) => {
      if (s.project?.id !== prev.project?.id) loadWatches(s.project?.id);
    });

    return () => {
      unsubStop();
      unsubBreakpoints();
      unsubProject();
    };
  }, []);
}
