"use client";

import { useEffect, useRef } from "react";
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
import { useExecution } from "@/features/execution/store";
import { CompareDialog } from "@/features/history/CompareDialog";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { NewProjectDialog } from "@/features/projects/NewProjectDialog";
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
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { useUI } from "./ui-store";


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
    if (layout.bottomOpen && p.isCollapsed()) p.expand();
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
          {layout.assistantOpen && <AssistantPanel onClose={() => updateLayout({ assistantOpen: false })} />}
        </Panel>
      </Group>
    </div>
  );
}

/** Tablet/phone: editor fills the screen; sidebar and panel open as drawers. */
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

function CompactWorkbench() {
  const drawer = useUI((s) => s.drawer);
  const setDrawer = useUI((s) => s.setDrawer);
  const updateLayout = useSettings((s) => s.updateLayout);
  const sideView = useSettings((s) => s.layout.sideView);
  const bottomTab = useSettings((s) => s.layout.bottomTab);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <EditorArea />
      </div>
      <nav aria-label="Panels" className="flex h-[52px] shrink-0 items-stretch border-t border-line bg-canvas px-1 pb-[env(safe-area-inset-bottom)]">
        {TABS.map((t) => {
          const active = t.kind === "side" ? drawer === "sidebar" && sideView === t.id : t.kind === "bottom" ? drawer === "bottom" && bottomTab === t.id : drawer === "assistant";
          return (
            <button
              key={t.id}
              aria-pressed={active}
              onClick={() => {
                if (t.kind === "side") {
                  updateLayout({ sideView: t.id });
                  setDrawer(active ? "none" : "sidebar");
                } else if (t.kind === "bottom") {
                  updateLayout({ bottomTab: t.id });
                  setDrawer(active ? "none" : "bottom");
                } else setDrawer(active ? "none" : "assistant");
              }}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] transition-colors [&_svg]:size-[18px]",
                active ? (t.kind === "ai" ? "text-[#8a7cf5]" : "text-accent") : "text-fg-subtle active:text-fg",
              )}
            >
              {active && <span aria-hidden className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-current" />}
              {t.icon}
              <span className="max-w-full truncate">{t.label}</span>
            </button>
          );
        })}
      </nav>

      {drawer !== "none" && (
        <button aria-label="Close drawer" className="absolute inset-0 bottom-[52px] z-20 bg-black/40 animate-fade" onClick={() => setDrawer("none")} />
      )}
      {drawer === "sidebar" && (
        <div className="absolute inset-y-0 bottom-[52px] left-0 z-30 w-[min(320px,85vw)] border-r border-line shadow-float animate-slide-up">
          <SideView />
        </div>
      )}
      {drawer === "bottom" && (
        <div className="absolute inset-x-0 bottom-[52px] z-30 h-[65%] border-t border-line shadow-float animate-slide-up">
          <BottomPanel onClose={() => setDrawer("none")} />
        </div>
      )}
      {drawer === "assistant" && (
        <div className="absolute inset-x-0 bottom-[52px] top-0 z-30 border-t border-line shadow-float animate-slide-up">
          <AssistantPanel onClose={() => setDrawer("none")} />
        </div>
      )}
    </div>
  );
}

export function WorkspaceShell() {
  const project = useWorkspace((s) => s.project);
  const status = useWorkspace((s) => s.status);
  const theme = useSettings((s) => s.theme);
  const hydrated = useSettings((s) => s.hydrated);
  const compact = useMediaQuery(COMPACT_QUERY);

  useGlobalKeybindings();
  useDebugSync();

  useEffect(() => {
    useSettings.getState().hydrate();
    void useWorkspace.getState().init();
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
        <StatusBar />
      </div>
      <CommandPalette />
      <NewProjectDialog />
      <SettingsDialog />
      <CompareDialog />
      <EntryPointDialog />
      <Toaster />
    </TooltipProvider>
  );
}
