"use client";

import { useEffect } from "react";
import { isRestricted } from "@/features/interview/restrict";
import { useWorkspace } from "@/features/projects/store";

/** Marks the browser-history entry of an open project. */
const stateOf = (id: string) => ({ cwProject: id });
const projectOf = (state: unknown): string | null => (state && typeof state === "object" && typeof (state as { cwProject?: unknown }).cwProject === "string" ? (state as { cwProject: string }).cwProject : null);

/** The address the project's entry was added at, while that entry is ours. */
let pushedAt: string | null = null;

/**
 * The open project is a step in the browser's history: Back in the editor
 * goes to the start screen (not to the site visited before), and Forward
 * opens the project again. The address stays the same; only the history
 * entry is added.
 */
export function useProjectHistory() {
  const id = useWorkspace((s) => s.project?.id ?? null);

  useEffect(() => {
    if (id) {
      // The first project adds an entry; switching projects reuses it.
      // After a reload the page is already on a project's entry: it is reused, not stacked on.
      if (pushedAt === null && projectOf(history.state) === null) history.pushState(stateOf(id), "");
      else if (projectOf(history.state) !== id) history.replaceState(stateOf(id), "");
      pushedAt = location.href;
      return;
    }
    if (pushedAt === null) return;
    // Closed from inside the app (Home, Close project): step back off the project's entry,
    // unless the address has changed since, when going back would load something else.
    const ours = projectOf(history.state) !== null && location.href === pushedAt;
    pushedAt = null;
    if (ours) history.back();
  }, [id]);

  // A page loaded on a project's entry with no project open (the site was reopened later): the entry is the start screen's.
  const ready = useWorkspace((s) => s.status !== "loading");
  useEffect(() => {
    if (ready && !useWorkspace.getState().project && pushedAt === null && projectOf(history.state) !== null) history.replaceState(null, "");
  }, [ready]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const ws = useWorkspace.getState();
      const wanted = projectOf(e.state);
      if (wanted) {
        // Forward, onto the project's entry. (A live session that was left is rejoined from its link, not from here.)
        if (wanted.startsWith("live-") && ws.project?.id !== wanted) return;
        // A project that no longer exists (deleted, temporary, or only opened and never changed): the entry is the start screen's now.
        if (ws.project?.id !== wanted && !ws.projects.some((p) => p.id === wanted)) {
          history.replaceState(null, "");
          pushedAt = null;
          if (ws.project) ws.closeProject();
          return;
        }
        pushedAt = location.href;
        if (ws.project?.id !== wanted) void ws.openProject(wanted);
        return;
      }
      if (pushedAt === null || !ws.project) return;
      // Back, off the project's entry. An interview candidate stays in the interview.
      if (isRestricted()) return void history.pushState(stateOf(ws.project.id), "");
      pushedAt = null;
      ws.closeProject();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
}
