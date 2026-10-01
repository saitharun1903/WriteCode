"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster, toast } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/primitives";
import { useDebugSync } from "@/features/debug/use-debug-sync";
import { useGlobalKeybindings } from "@/features/commands/keybindings";
import { useExecution } from "@/features/execution/store";
import { StartScreen } from "@/features/projects/StartScreen";
import { useWorkspace } from "@/features/projects/store";
import { resolveTheme, useSettings } from "@/features/settings/store";
import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { useUI } from "./ui-store";
import { useProjectHistory } from "./use-project-history";
import { LiveStrip } from "@/features/live/LiveUI";
import { promptJoin } from "@/features/live/store";
import { useRestriction } from "@/features/interview/restrict";
// Watches for an interview being opened or started, so it is here from the start.
import "@/features/interview/interviewer";
import { getLanguage, isLiveRoomId } from "@cw/shared";

const Loading = () => (
  <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-subtle">
    <Spinner /> Loading workspace…
  </div>
);

// Neither is needed to show the start screen, so neither is part of its download.
const loadWorkbench = () => import("./Workbench").then((m) => m.Workbench);
const loadDialogs = () => import("./Dialogs").then((m) => m.Dialogs);
const Workbench = dynamic(loadWorkbench, { ssr: false, loading: Loading });
const Dialogs = dynamic(loadDialogs, { ssr: false });

/** True from the visitor's first move on the page (a pointer, a key, a touch, a scroll). */
function useFirstMove(): boolean {
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    const events = ["pointermove", "pointerdown", "touchstart", "keydown", "wheel"] as const;
    const on = () => setMoved(true);
    for (const e of events) window.addEventListener(e, on, { once: true, passive: true, capture: true });
    return () => {
      for (const e of events) window.removeEventListener(e, on, { capture: true });
    };
  }, []);
  return moved;
}

/** The link is read once per page load (effects run twice in development). */
let liveLinkHandled = false;
let newProjectHandled = false;

/** `live`: the page was opened from a live session link (`/live#<id>`). */
export function WorkspaceShell({ live = false }: { live?: boolean }) {
  const project = useWorkspace((s) => s.project);
  const status = useWorkspace((s) => s.status);
  const theme = useSettings((s) => s.theme);
  const hydrated = useSettings((s) => s.hydrated);
  const compact = useMediaQuery(COMPACT_QUERY);
  const restricted = useRestriction((s) => s.restricted);

  useGlobalKeybindings();
  useDebugSync();
  useProjectHistory();

  useEffect(() => {
    if (!live) return;
    const handle = () => {
      const roomId = location.hash.slice(1);
      if (isLiveRoomId(roomId)) return promptJoin(roomId);
      toast.error("This live session link is not complete", "Ask for the link again and open all of it.");
      history.replaceState(null, "", "/");
    };
    if (!liveLinkHandled) {
      liveLinkHandled = true;
      handle();
    }
    // The same tab opening another (or the same) link again.
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, [live]);

  useEffect(() => {
    useSettings.getState().hydrate();
    const init = useWorkspace.getState().init();
    // Landing pages link to /?new=<language>: start a project in that language.
    const wanted = new URLSearchParams(location.search).get("new");
    if (wanted && !newProjectHandled) {
      newProjectHandled = true;
      history.replaceState(null, "", location.pathname + location.hash);
      if (getLanguage(wanted)) void init.then(() => useWorkspace.getState().createProject(wanted));
    }
  }, []);

  // The editor and the workbench are fetched once the visitor shows they are here (not while
  // the page is still arriving), so opening a project is instant without slowing the first paint.
  const moved = useFirstMove();
  useEffect(() => {
    if (!moved) return;
    void loadWorkbench();
    void import("@/features/editor/monaco-setup").then((m) => m.preloadMonaco());
  }, [moved]);

  // Apply theme, following the OS when set to "system".
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // Poll runner health: quickly while offline, rarely while online.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await useExecution.getState().checkHealth();
      timer = setTimeout(tick, useExecution.getState().runner === "online" ? 60_000 : 10_000);
    };
    void tick();
    return () => clearTimeout(timer);
  }, []);

  // Never lose the last few keystrokes when the tab is hidden or closed.
  useEffect(() => {
    const flush = () => void useWorkspace.getState().flush();
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Close drawers when leaving compact mode. Touch screens get larger buttons and fields (see `data-touch` in the components).
  useEffect(() => {
    if (!compact) useUI.getState().setDrawer("none");
    document.documentElement.toggleAttribute("data-touch", compact);
  }, [compact]);

  const loading = status === "loading" || !hydrated;

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col bg-canvas">
        <TitleBar compact={compact} />
        <LiveStrip />
        {loading || !project ? (
          // The start screen is part of the page as it is served (search engines read it there);
          // while the saved projects load, it waits behind the loading notice.
          <main className="relative min-h-0 flex-1">
            <StartScreen />
            {loading && (
              // A browser that has never been here has nothing to load: it sees the start screen at once (`data-fresh`, set before the first paint).
              <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-canvas text-sm text-fg-subtle [[data-fresh]_&]:hidden">
                <Spinner /> Loading workspace…
              </div>
            )}
          </main>
        ) : (
          <main className="flex min-h-0 flex-1 flex-col">
            <Workbench compact={compact} />
          </main>
        )}
        {!compact && !(restricted && project) && <StatusBar />}
      </div>
      {/* A session link, or an open project, needs them now. */}
      {(moved || live || !!project) && <Dialogs />}
      <Toaster />
    </TooltipProvider>
  );
}
