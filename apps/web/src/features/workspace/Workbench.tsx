"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import dynamic from "next/dynamic";
import { Bug, FileText, FlaskConical, FolderClosed, History, Play, Sparkles, Workflow } from "lucide-react";
import { Group, Panel, Separator, useDefaultLayout, type PanelImperativeHandle } from "react-resizable-panels";
import { getLanguage } from "@cw/shared";
import { usePreview } from "@/features/preview/store";
import { useWorkspace } from "@/features/projects/store";
import { EditorArea } from "@/features/editor/EditorArea";
import { editorBridge } from "@/features/editor/bridge";
import { FileExplorer } from "@/features/explorer/FileExplorer";
import { DatabasePanel } from "@/features/sql/DatabasePanel";
import { isRunning, useExecution } from "@/features/execution/store";
import { useDebug } from "@/features/debug/store";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { SearchPanel } from "@/features/search/SearchPanel";
import { useSettings, type BottomTab, type SideView } from "@/features/settings/store";
import { cn } from "@/lib/cn";
import { useMediaQuery } from "@/lib/use-media";
import { ActivityBar } from "./ActivityBar";
import { BottomPanel } from "./BottomPanel";
import { PanelTabs, type DockItem } from "./PanelTabs";
import { useUI } from "./ui-store";
import { useLive } from "@/features/live/store";
import { InterviewPanel } from "@/features/interview/InterviewPanel";
import { CandidateTests } from "@/features/interview/CandidateTests";
import { useCandidate } from "@/features/interview/candidate";
import { useRestriction } from "@/features/interview/restrict";

const separatorClass =
  "relative bg-line outline-none transition-colors data-[separator]:hover:bg-accent-line data-[separator=active]:bg-accent focus-visible:bg-accent";

const PreviewPanel = dynamic(() => import("@/features/preview/PreviewPanel").then((m) => m.PreviewPanel), { ssr: false });
// Downloaded the first time the assistant is opened.
const AssistantPanel = dynamic(() => import("@/features/assistant/AssistantPanel").then((m) => m.AssistantPanel), { ssr: false });

/** A SQL project's explorer, as in a database tool: the database and what is in it, then the files of SQL. */
function SqlExplorer() {
  const split = useDefaultLayout({ id: "cw-sql-side", panelIds: ["database", "files"] });
  return (
    <Group orientation="vertical" id="cw-sql-side" defaultLayout={split.defaultLayout} onLayoutChanged={split.onLayoutChanged}>
      <Panel id="database" defaultSize="58%" minSize="96px">
        <DatabasePanel />
      </Panel>
      <Separator className={cn(separatorClass, "h-px")} />
      <Panel id="files" minSize="96px">
        <FileExplorer title="SQL files" />
      </Panel>
    </Group>
  );
}

function SideView() {
  const view = useSettings((s) => s.layout.sideView);
  const database = useWorkspace((s) => !!s.project && !!getLanguage(s.project.language)?.database);
  return (
    <aside aria-label="Sidebar" className="h-full min-h-0 bg-surface">
      {view === "explorer" && (database ? <SqlExplorer /> : <FileExplorer />)}
      {view === "search" && <SearchPanel />}
      {view === "history" && <HistoryPanel />}
    </aside>
  );
}

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
  const aiOn = useSettings((s) => s.ai);

  // The assistant turned off in Settings closes its panel (an interview's panel stays).
  useEffect(() => {
    if (!aiOn && !interview && layout.assistantOpen) updateLayout({ assistantOpen: false });
  }, [aiOn, interview, layout.assistantOpen, updateLayout]);

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

  // The visualizer draws frames and objects side by side, and a SQL run prints tables: give them room when they open.
  const tables = useWorkspace((s) => !!s.project && getLanguage(s.project.language)?.output === "tables");
  useEffect(() => {
    const p = bottomRef.current;
    if (!p || !layout.bottomOpen || !(layout.bottomTab === "visualize" || (layout.bottomTab === "run" && tables))) return;
    if (p.getSize().asPercentage < 50) p.resize("55%");
  }, [layout.bottomOpen, layout.bottomTab, tables]);
  // A project that runs in the browser: its page stands beside the code.
  const previews = useWorkspace((s) => !!s.project && !!getLanguage(s.project.language)?.preview);
  const previewOpen = usePreview((s) => s.open);
  const previewFull = usePreview((s) => s.full);
  const split = useDefaultLayout({ id: "cw-preview-2", panelIds: ["code", "preview"] });

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
              {previews ? (
                <Group orientation="horizontal" id="cw-preview-2" defaultLayout={split.defaultLayout} onLayoutChanged={split.onLayoutChanged}>
                  <Panel id="code" minSize="30%">
                    <EditorArea />
                  </Panel>
                  {previewOpen && (
                    <>
                      <Separator className={cn(separatorClass, "w-px")} />
                      <Panel id="preview" defaultSize="36%" minSize="280px">
                        <PreviewPanel full={previewFull} />
                      </Panel>
                    </>
                  )}
                </Group>
              ) : (
                <EditorArea />
              )}
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

const cardClass = "h-full min-h-0 overflow-hidden rounded-xl border border-line bg-surface";
const gapClass = "relative outline-none after:absolute after:inset-0 after:m-auto after:rounded-full after:bg-line-strong after:transition-colors data-[separator]:hover:after:bg-accent data-[separator=active]:after:bg-accent";

/**
 * An interview candidate's desk, laid out like a judge: the problem on the
 * left, the code on the right, and under it the cases to run on and the result.
 */
function CandidateWorkbench() {
  const outer = useDefaultLayout({ id: "cw-candidate", panelIds: ["problem", "code"] });
  const inner = useDefaultLayout({ id: "cw-candidate-code", panelIds: ["editor", "tests"] });
  return (
    <div className="flex min-h-0 flex-1 bg-canvas p-2">
      <Group orientation="horizontal" id="cw-candidate" defaultLayout={outer.defaultLayout} onLayoutChanged={outer.onLayoutChanged} className="min-w-0 flex-1">
        <Panel id="problem" defaultSize="40%" minSize="280px" maxSize="65%">
          <div className={cardClass}>
            <InterviewPanel />
          </div>
        </Panel>
        <Separator className={cn(gapClass, "w-2 after:h-8 after:w-0.5")} />
        <Panel id="code" minSize="30%">
          <Group orientation="vertical" id="cw-candidate-code" defaultLayout={inner.defaultLayout} onLayoutChanged={inner.onLayoutChanged}>
            <Panel id="editor" defaultSize="60%" minSize="20%">
              <div className={cardClass}>
                <EditorArea />
              </div>
            </Panel>
            <Separator className={cn(gapClass, "h-2 after:h-0.5 after:w-8")} />
            <Panel id="tests" defaultSize="40%" minSize="96px">
              <div className={cardClass}>
                <CandidateTests />
              </div>
            </Panel>
          </Group>
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

/**
 * The debugger's and visualizer's sheet on a phone: most of the screen's lower part, but never so
 * little that its variables cannot be seen on a short phone. `followSheetHeight` is the same in pixels.
 */
const FOLLOW_SHEET = "max(min(62%, 560px), min(380px, 78%))";
const followSheetHeight = (h: number) => Math.max(Math.min(h * 0.62, 560), Math.min(380, h * 0.78));

/** Whether the on-screen keyboard is up; the tab bar steps aside while it is. */
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

const SHEET_SPRING = { type: "spring", stiffness: 420, damping: 40, mass: 0.9 } as const;

/** Phones: a panel that rises from the bottom, above the tab bar; drag it down (or tap outside) to close it. */
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
      className="cw-sheet absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[20px] border-t border-line bg-surface"
      style={{ height }}
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

/**
 * Phones and tablets. A phone has the code, a tab bar under it, and panels that
 * rise over the code as sheets. A tablet has room to keep the code in view: a
 * rail of tabs down the left, and the panel that is open sits beside or under
 * the code, as on a desktop.
 */
function CompactWorkbench() {
  const drawer = useUI((s) => s.drawer);
  const interview = useLive((s) => !!s.interview);
  const aiOn = useSettings((s) => s.ai);
  const restricted = useRestriction((s) => s.restricted);
  const candidateBusy = useCandidate((s) => s.phase !== "idle");
  const setDrawer = useUI((s) => s.setDrawer);
  const updateLayout = useSettings((s) => s.updateLayout);
  const sideView = useSettings((s) => s.layout.sideView);
  const bottomTab = useSettings((s) => s.layout.bottomTab);
  const run = useExecution((s) => s.run);
  const paused = useDebug((s) => s.phase === "paused");
  const keyboard = useKeyboardOpen();
  // A project that runs in the browser: on a phone its page opens over the code, like a link inside an app.
  const previews = useWorkspace((s) => !!s.project && !!getLanguage(s.project.language)?.preview);
  const previewOpen = usePreview((s) => s.open) && previews && !restricted;
  const previewFull = usePreview((s) => s.full);
  const tablet = useMediaQuery("(min-width: 700px)");
  // Wide enough for the assistant to stand beside the code.
  const roomy = useMediaQuery("(min-width: 1000px)");
  /** The keyboard is up for the code: the panel under it steps aside. */
  const [typingCode, setTypingCode] = useState(false);
  const close = () => setDrawer("none");
  // Debugging and visualizing on a phone are about the line that runs: their sheet leaves more of the
  // code in view, barely dimmed, and the editor keeps that line in the part above the sheet.
  const followsCode = !tablet && drawer === "bottom" && !restricted && (bottomTab === "debug" || bottomTab === "visualize");
  const codeArea = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = codeArea.current;
    if (!followsCode || !el) return;
    const measure = () => editorBridge.setCoveredBelow(followSheetHeight(el.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      editorBridge.setCoveredBelow(0);
    };
  }, [followsCode]);

  const running = !!run && isRunning(run);
  // An interview candidate has two things besides the code: the problem and the tests.
  const candidateItems: DockItem[] = [
    { id: "problem", label: "Problem", icon: <FileText />, active: drawer === "assistant", onSelect: () => setDrawer(drawer === "assistant" ? "none" : "assistant") },
    { id: "tests", label: "Tests", icon: <FlaskConical />, active: drawer === "bottom", dot: candidateBusy ? "run" : undefined, onSelect: () => setDrawer(drawer === "bottom" ? "none" : "bottom") },
  ];
  // With the assistant turned off in Settings there is no AI tab (an interview's panel stays).
  const tabs = aiOn || interview ? TABS : TABS.filter((t) => t.kind !== "ai");
  const items: DockItem[] = restricted ? candidateItems : tabs.map((t) => {
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
      onSelect: () => {
        if (t.kind === "side") {
          updateLayout({ sideView: t.id });
          setDrawer(active ? "none" : "sidebar");
        } else if (t.id === "run" && previews) {
          usePreview.getState().run();
        } else if (t.kind === "bottom") {
          updateLayout({ bottomTab: t.id });
          setDrawer(active ? "none" : "bottom");
        } else setDrawer(active ? "none" : "assistant");
      },
    };
  });

  const bottom = restricted ? <CandidateTests actions={false} /> : <BottomPanel onClose={close} />;
  const assistant = interview ? <InterviewPanel onClose={close} /> : <AssistantPanel onClose={close} />;

  if (tablet) {
    const under = keyboard && typingCode ? "hidden" : "";
    return (
      <div className="flex min-h-0 flex-1">
        <PanelTabs rail items={items} />
        {drawer === "sidebar" && !restricted && (
          <div className="w-[300px] shrink-0 border-r border-line">
            <SideView />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1" onFocusCapture={() => setTypingCode(true)} onBlurCapture={() => setTypingCode(false)}>
            <EditorArea />
          </div>
          {drawer === "bottom" && <div className={cn("shrink-0 border-t border-line bg-surface", bottomTab === "visualize" && !restricted ? "h-[58%]" : "h-[44%]", under)}>{bottom}</div>}
          {drawer === "assistant" && !roomy && <div className={cn("h-[58%] shrink-0 border-t border-line bg-surface", under)}>{assistant}</div>}
        </div>
        {drawer === "assistant" && roomy && <div className="w-[400px] shrink-0 border-l border-line bg-surface">{assistant}</div>}
        {previewOpen && (
          <div className={cn("shrink-0 border-l border-line", roomy ? "w-[40%]" : "w-0")}>
            <PreviewPanel full={previewFull || !roomy} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={codeArea} className="relative min-h-0 flex-1 overflow-hidden">
        <EditorArea />
        <AnimatePresence>
          {drawer !== "none" && (
            <motion.button
              key="scrim"
              aria-label="Close panel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={cn("absolute inset-0 z-20", followsCode ? "bg-black/15" : "bg-black/45")}
              onClick={close}
            />
          )}
          {drawer === "sidebar" && !restricted && (
            <Sheet key="sidebar" side onClose={close} height="auto">
              <SideView />
            </Sheet>
          )}
          {drawer === "bottom" && (
            <Sheet key="bottom" onClose={close} height={followsCode ? FOLLOW_SHEET : "min(78%, 640px)"}>
              {bottom}
            </Sheet>
          )}
          {drawer === "assistant" && (
            <Sheet key="assistant" onClose={close} height="calc(100% - 8px)">
              {assistant}
            </Sheet>
          )}
        </AnimatePresence>
      </div>
      {/* The tab bar gives its room to the keyboard while it is up. */}
      {!keyboard && <PanelTabs items={items} />}
      {previewOpen && <PreviewPanel full />}
    </div>
  );
}

/**
 * Everything around an open project: the editor and its tool windows, laid
 * out for a desktop, an interview candidate, or a phone or tablet. It is not
 * part of the start screen's download.
 */
export function Workbench({ compact }: { compact: boolean }) {
  const restricted = useRestriction((s) => s.restricted);
  return compact ? <CompactWorkbench /> : restricted ? <CandidateWorkbench /> : <DesktopWorkbench />;
}
