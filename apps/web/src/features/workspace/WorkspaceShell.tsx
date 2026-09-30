"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { Bug, FlaskConical, FolderClosed, History, Play, Sparkles, Workflow } from "lucide-react";
import { Group, Panel, Separator, useDefaultLayout, type PanelImperativeHandle } from "react-resizable-panels";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/primitives";
import { CommandPalette } from "@/features/commands/CommandPalette";
import { useDebugSync } from "@/features/debug/use-debug-sync";
import { useGlobalKeybindings } from "@/features/commands/keybindings";
import { EditorArea } from "@/features/editor/EditorArea";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { isRunning, useExecution } from "@/features/execution/store";
import { useDebug } from "@/features/debug/store";
import { CompareDialog } from "@/features/history/CompareDialog";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";
import { ImportDialog } from "@/features/projects/ImportDialog";
import { EntryPointDialog } from "@/features/execution/EntryPointDialog";
import { StartScreen } from "@/features/projects/StartScreen";
import { useWorkspace } from "@/features/projects/store";
import { SearchPanel } from "@/features/search/SearchPanel";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { resolveTheme, useSettings, type BottomTab, type SideView } from "@/features/settings/store";
import { cn } from "@/lib/cn";
import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";
import { ActivityBar } from "./ActivityBar";
import { BottomPanel } from "./BottomPanel";
import { GlassDock, type DockItem } from "./GlassDock";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { useUI } from "./ui-store";
import { JoinDialog, LivePanel, LiveStrip, SessionEndedDialog } from "@/features/live/LiveUI";
import { promptJoin, useLive } from "@/features/live/store";
import { InterviewPanel } from "@/features/interview/InterviewPanel";
import { InterviewSetupDialog } from "@/features/interview/InterviewSetupDialog";
import { ReplayDialog } from "@/features/interview/ReplayDialog";
import { CandidateGate } from "@/features/interview/CandidateGate";
import "@/features/interview/interviewer";
import { getLanguage, isLiveRoomId } from "@cw/shared";
import { toast } from "@/components/ui/toast";


// Downloaded the first time the assistant is opened.
const AssistantPanel = dynamic(() => import("@/features/assistant/AssistantPanel").then((m) => m.AssistantPanel), { ssr: false });

function SideView() {
  const view = useSettings((s) => s.layout.sideView);
  return (
    <aside aria-label="Sidebar" className="h-full min-h-0 bg-surface">
      {view === "explorer" && <FileExplorer />}
      {view === "search" && <SearchPanel />}
      {view === "history" && <HistoryPanel />}
    </aside>
  );
}

const separatorClass =
  "relative bg-line outline-none transition-colors data-[separator]:hover:bg-accent-line data-[separator=active]:bg-accent focus-visible:bg-accent";

/** Desktop: resizable, collapsible panels whose sizes persist per browser. */
function DesktopWorkbench() {
  const layout = useSettings((s) => s.layout);
  const interview = useLive((s) => !!s.interview);
  const updateLayout = useSettings((s) => s.updateLayout);
  const sideRef = useRef<PanelImperativeHandle | null>(null);
  const bottomRef = useRef<PanelImperativeHandle | null>(null);
  const assistantRef = useRef<PanelImperativeHandle | null>(null);

  const outer = useDefaultLayout({ id: "cw-outer", panelIds: ["side", "main", "assistant"] });
  const inner = useDefaultLayout({ id: "cw-inner", panelIds: ["editor", "bottom"] });

  // Keep imperative panel state in sync with persisted layout flags.
  useEffect(() => {
    const p = sideRef.current;
    if (!p) return;
    if (layout.sidebarOpen && p.isCollapsed()) p.expand();
    if (!layout.sidebarOpen && !p.isCollapsed()) p.collapse();
  }, [layout.sidebarOpen]);

  useEffect(() => {
    const p = bottomRef.current;
    if (!p) return;
    if (layout.bottomOpen && p.isCollapsed()) {
      p.expand();
      // A panel that starts closed has no size to return to and would reopen at its minimum.
      if (p.getSize().asPercentage < 20) p.resize("32%");
    }
    if (!layout.bottomOpen && !p.isCollapsed()) p.collapse();
  }, [layout.bottomOpen]);

  useEffect(() => {
    const p = assistantRef.current;
    if (!p) return;
    if (layout.assistantOpen && p.isCollapsed()) {
      p.expand();
      // Answers with code and tables need room; open at a comfortable width.
      if (p.getSize().inPixels < 400) p.resize("420px");
    }
    if (!layout.assistantOpen && !p.isCollapsed()) p.collapse();
  }, [layout.assistantOpen]);

  // The visualizer draws frames and objects side by side; give it room when it opens.
  useEffect(() => {
    const p = bottomRef.current;
    if (!p || !layout.bottomOpen || layout.bottomTab !== "visualize") return;
    if (p.getSize().asPercentage < 50) p.resize("55%");
  }, [layout.bottomOpen, layout.bottomTab]);

  return (
    <div className="flex min-h-0 flex-1">
      <ActivityBar />
      <Group orientation="horizontal" id="cw-outer" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged} className="min-w-0 flex-1">
        <Panel
          id="side"
          panelRef={sideRef}
          defaultSize="240px"
          minSize="170px"
          maxSize="45%"
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            const open = size.inPixels > 0;
            if (open !== useSettings.getState().layout.sidebarOpen) updateLayout({ sidebarOpen: open });
          }}
        >
          <SideView />
        </Panel>
        <Separator className={cn(separatorClass, "w-px")} />
        <Panel id="main" minSize="30%">
          <Group orientation="vertical" id="cw-inner" defaultLayout={inner.defaultLayout} onLayoutChanged={inner.onLayoutChanged}>
            <Panel id="editor" minSize="20%">
              <EditorArea />
            </Panel>
            <Separator className={cn(separatorClass, "h-px")} />
            <Panel
              id="bottom"
              panelRef={bottomRef}
              defaultSize="32%"
              minSize="90px"
              collapsible
              collapsedSize={0}
              onResize={(size) => {
                const open = size.inPixels > 0;
                if (open !== useSettings.getState().layout.bottomOpen) updateLayout({ bottomOpen: open });
              }}
            >
              <BottomPanel onClose={() => updateLayout({ bottomOpen: false })} />
            </Panel>
          </Group>
        </Panel>
        <Separator className={cn(separatorClass, "w-px")} />
        <Panel
          id="assistant"
          panelRef={assistantRef}
          defaultSize={layout.assistantOpen ? "420px" : "0px"}
          minSize="300px"
          maxSize="50%"
          collapsible
          collapsedSize={0}
          onResize={(size) => {
            const open = size.inPixels > 0;
            if (open !== useSettings.getState().layout.assistantOpen) updateLayout({ assistantOpen: open });
          }}
        >
          {layout.assistantOpen && (interview ? <InterviewPanel onClose={() => updateLayout({ assistantOpen: false })} /> : <AssistantPanel onClose={() => updateLayout({ assistantOpen: false })} />)}
        </Panel>
      </Group>
    </div>
  );
}

/** Phone and tablet tab bar: the tool windows people reach for most, with Search in the title bar. */
const TABS: ({ label: string; icon: React.ReactNode } & ({ kind: "side"; id: SideView } | { kind: "bottom"; id: BottomTab } | { kind: "ai"; id: "ai" }))[] = [
  { kind: "side", id: "explorer", label: "Files", icon: <FolderClosed /> },
  { kind: "bottom", id: "run", label: "Run", icon: <Play /> },
  { kind: "bottom", id: "debug", label: "Debug", icon: <Bug /> },
  { kind: "bottom", id: "visualize", label: "Visualize", icon: <Workflow /> },
  { kind: "bottom", id: "tests", label: "Tests", icon: <FlaskConical /> },
  { kind: "side", id: "history", label: "History", icon: <History /> },
  { kind: "ai", id: "ai", label: "AI", icon: <Sparkles /> },
];

/** How far the on-screen keyboard has pushed the layout up; the dock steps aside while it is open. */
function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // The tallest the window has been in this orientation: a much shorter one means the keyboard is up.
    const tallest = { portrait: 0, landscape: 0 };
    const check = () => {
      const key = window.innerWidth > window.innerHeight ? "landscape" : "portrait";
      const height = window.visualViewport?.height ?? window.innerHeight;
      tallest[key] = Math.max(tallest[key], window.innerHeight, height);
      setOpen(tallest[key] - height > 140);
    };
    check();
    window.addEventListener("resize", check);
    window.visualViewport?.addEventListener("resize", check);
    return () => {
      window.removeEventListener("resize", check);
      window.visualViewport?.removeEventListener("resize", check);
    };
  }, []);
  return open;
}

/** Room the floating dock takes at the bottom of the screen. */
const DOCK_SPACE = "calc(62px + 22px + env(safe-area-inset-bottom))";

const SHEET_SPRING = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const;

/** A panel that rises from the bottom above the dock; drag it down (or tap outside) to close it. */
function Sheet({ children, onClose, height, side = false }: { children: React.ReactNode; onClose: () => void; height: string; side?: boolean }) {
  const reduce = useReducedMotion();
  const controls = useDragControls();
  if (side) {
    return (
      <motion.div
        key="side"
        initial={reduce ? false : { x: "-100%" }}
        animate={{ x: 0 }}
        exit={reduce ? { opacity: 0 } : { x: "-100%" }}
        transition={SHEET_SPRING}
        className="cw-sheet absolute bottom-0 left-0 top-0 z-30 w-[min(340px,86vw)] overflow-hidden border-r border-line bg-surface"
        style={{ paddingBottom: DOCK_SPACE }}
      >
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div
      initial={reduce ? false : { y: "100%" }}
      animate={{ y: 0 }}
      exit={reduce ? { opacity: 0 } : { y: "105%" }}
      transition={SHEET_SPRING}
      drag="y"
      dragControls={controls}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={(_, info) => {
        if (info.offset.y > 110 || info.velocity.y > 600) onClose();
      }}
      className="cw-sheet absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[22px] border-t border-line bg-surface"
      // Runs down behind the dock, so the glass floats over the panel; its content stops above the dock.
      style={{ height: `calc(${height} + ${DOCK_SPACE})`, paddingBottom: DOCK_SPACE }}
    >
      <Grabber onDragStart={(e) => controls.start(e)} />
      <div className="min-h-0 flex-1">{children}</div>
    </motion.div>
  );
}

/** The grabber at the top of a sheet: drag it down to close. */
function Grabber({ onDragStart }: { onDragStart: (e: React.PointerEvent) => void }) {
  return (
    <div onPointerDown={onDragStart} className="flex h-5 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing">
      <span className="h-[5px] w-10 rounded-full bg-fg-faint/60" />
    </div>
  );
}

/** Tablet/phone: the editor fills the screen; panels rise as sheets above a floating glass dock. */
function CompactWorkbench() {
  const drawer = useUI((s) => s.drawer);
  const interview = useLive((s) => !!s.interview);
  const setDrawer = useUI((s) => s.setDrawer);
  const updateLayout = useSettings((s) => s.updateLayout);
  const sideView = useSettings((s) => s.layout.sideView);
  const bottomTab = useSettings((s) => s.layout.bottomTab);
  const run = useExecution((s) => s.run);
  const paused = useDebug((s) => s.phase === "paused");
  const keyboard = useKeyboardOpen();
  const reduce = useReducedMotion();
  const close = () => setDrawer("none");

  const running = !!run && isRunning(run);
  const items: DockItem[] = TABS.map((t) => {
    const active = t.kind === "side" ? drawer === "sidebar" && sideView === t.id : t.kind === "bottom" ? drawer === "bottom" && bottomTab === t.id : drawer === "assistant";
    const dot: DockItem["dot"] =
      t.id === "run" && running && run!.mode === "run"
        ? "run"
        : t.id === "debug" && running && run!.mode === "debug"
          ? paused
            ? "pause"
            : "run"
          : t.id === "visualize" && running && run!.mode === "visualize"
            ? "record"
            : undefined;
    return {
      id: t.id,
      label: t.label,
      icon: t.icon,
      active,
      dot,
      tone: t.kind === "ai" ? "ai" : undefined,
      onSelect: () => {
        if (t.kind === "side") {
          updateLayout({ sideView: t.id });
          setDrawer(active ? "none" : "sidebar");
        } else if (t.kind === "bottom") {
          updateLayout({ bottomTab: t.id });
          setDrawer(active ? "none" : "bottom");
        } else setDrawer(active ? "none" : "assistant");
      },
    };
  });

  return (
    <div className="cw-dock-layer relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <EditorArea />
      </div>

      <AnimatePresence>
        {drawer !== "none" && (
          <motion.button
            key="scrim"
            aria-label="Close panel"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 z-20 bg-black/45"
            onClick={close}
          />
        )}
        {drawer === "sidebar" && (
          <Sheet key="sidebar" side onClose={close} height="auto">
            <SideView />
          </Sheet>
        )}
        {drawer === "bottom" && (
          <Sheet key="bottom" onClose={close} height="min(72%, 640px)">
            <BottomPanel onClose={close} />
          </Sheet>
        )}
        {drawer === "assistant" && (
          <Sheet key="assistant" onClose={close} height={`calc(100% - 8px)`}>
            {interview ? <InterviewPanel onClose={close} /> : <AssistantPanel onClose={close} />}
          </Sheet>
        )}
      </AnimatePresence>

      {/* Floats over the editor; the code scrolls up from under the glass. */}
      <motion.div
        aria-hidden={keyboard}
        initial={false}
        animate={keyboard ? { y: 120, opacity: 0 } : { y: 0, opacity: 1 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 34 }}
        className="pointer-events-none absolute inset-x-0 z-40 flex justify-center px-3"
        style={{ bottom: "calc(12px + env(safe-area-inset-bottom))" }}
      >
        <div className="w-full max-w-[560px]">
          <GlassDock items={items} />
        </div>
      </motion.div>
    </div>
  );
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

  useGlobalKeybindings();
  useDebugSync();

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
    // Fetch the editor while the start screen is showing, so opening a project is instant.
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 300));
    idle(() => void import("@/features/editor/monaco-setup").then((m) => m.preloadMonaco()));
  }, []);

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

  // Close drawers when leaving compact mode.
  useEffect(() => {
    if (!compact) useUI.getState().setDrawer("none");
  }, [compact]);

  const loading = status === "loading" || !hydrated;

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col bg-canvas">
        <TitleBar compact={compact} />
        <LiveStrip />
        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-subtle">
            <Spinner /> Loading workspace…
          </div>
        ) : !project ? (
          <main className="min-h-0 flex-1">
            <StartScreen />
          </main>
        ) : (
          <main className="flex min-h-0 flex-1 flex-col">{compact ? <CompactWorkbench /> : <DesktopWorkbench />}</main>
        )}
        {!(compact && project) && <StatusBar />}
      </div>
      <CommandPalette />
      <NewProjectDialog />
      <SettingsDialog />
      <ImportDialog />
      <CompareDialog />
      <EntryPointDialog />
      <LivePanel />
      <JoinDialog />
      <InterviewSetupDialog />
      <ReplayDialog />
      <CandidateGate />
      <SessionEndedDialog />
      <Toaster />
    </TooltipProvider>
  );
}
