"use client";

import { anyFileIsRunnable, findEntryPoints, getLanguage, parentOf } from "@cw/shared";
import { toast } from "@/components/ui/toast";
import { useDebug } from "@/features/debug/store";
import { editorBridge, useCursor } from "@/features/editor/bridge";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSnapshots } from "@/features/history/snapshot-store";
import { DEFAULT_SETTINGS, resolveTheme, useSettings, type BottomTab, type SideView } from "@/features/settings/store";
import { useUI } from "@/features/workspace/ui-store";

export interface Command {
  id: string;
  title: string;
  category: "Run" | "Debug" | "File" | "Edit" | "View" | "Project" | "Preferences" | "Go";
  /** Display + binding, e.g. "Mod+Shift+P". Multiple bindings separated by " / ". */
  shortcut?: string;
  /** Returns false when the command cannot run in the current state. */
  enabled?: () => boolean;
  run: () => void;
}

const hasProject = () => !!useWorkspace.getState().project;

/** True when the open project's language has a working debugger. */
export function canDebug(): boolean {
  const project = useWorkspace.getState().project;
  const dbg = project ? getLanguage(project.language)?.debugger : undefined;
  return !!dbg && dbg.supportLevel !== "planned";
}

const debugPhase = () => useDebug.getState().phase;
const inDebugSession = () => {
  const run = useExecution.getState().run;
  return run?.mode === "debug" && isRunning(run);
};

function startDebugging() {
  showBottom("debug");
  void useExecution.getState().execute({ mode: "debug" });
}

function showSide(view: SideView) {
  useSettings.getState().updateLayout({ sidebarOpen: true, sideView: view });
  useUI.getState().setDrawer("sidebar");
}

/** True when the active file can be run on its own: it has a main function, or the language runs any file. */
function activeFileRunnable(): boolean {
  const { project, activeFile } = useWorkspace.getState();
  if (!project || !activeFile) return false;
  const lang = getLanguage(project.language);
  if (!lang?.extensions.some((e) => activeFile.toLowerCase().endsWith(e))) return false;
  if (anyFileIsRunnable(project.language)) return true;
  const file = project.files.find((f) => f.path === activeFile);
  return !!file && findEntryPoints(project.language, [file]).length > 0;
}

/** True when the open project's language has a working visualizer. */
export function canVisualize(): boolean {
  const project = useWorkspace.getState().project;
  const viz = project ? getLanguage(project.language)?.visualizer : undefined;
  return !!viz && viz.supportLevel !== "planned";
}

export function showBottom(tab: BottomTab) {
  useSettings.getState().updateLayout({ bottomOpen: true, bottomTab: tab });
  useUI.getState().setDrawer("bottom");
}

export const COMMANDS: Command[] = [
  {
    id: "run.execute",
    title: "Run",
    category: "Run",
    shortcut: "Mod+Enter",
    enabled: () => hasProject() && !isRunning(useExecution.getState().run),
    run: () => {
      showBottom("run");
      void useExecution.getState().execute();
    },
  },
  {
    id: "run.visualize",
    title: "Visualize Execution",
    category: "Run",
    shortcut: "Mod+Alt+Enter",
    enabled: () => hasProject() && canVisualize() && !isRunning(useExecution.getState().run),
    run: () => {
      showBottom("visualize");
      void useExecution.getState().execute({ mode: "visualize" });
    },
  },
  {
    id: "run.currentFile",
    title: "Run Current File",
    category: "Run",
    shortcut: "Mod+Shift+F10",
    enabled: () => activeFileRunnable() && !isRunning(useExecution.getState().run),
    run: () => {
      const file = useWorkspace.getState().activeFile;
      if (!file) return;
      showBottom("run");
      void useExecution.getState().execute({ entry: file });
    },
  },
  {
    id: "run.cancel",
    title: "Stop",
    category: "Run",
    shortcut: "Shift+F5",
    enabled: () => isRunning(useExecution.getState().run),
    run: () => void useExecution.getState().cancel(),
  },
  {
    id: "debug.startOrContinue",
    title: "Start Debugging / Continue",
    category: "Debug",
    shortcut: "F5",
    enabled: () => hasProject() && (debugPhase() === "paused" || !isRunning(useExecution.getState().run)),
    run: () => {
      if (debugPhase() === "paused" && inDebugSession()) return useDebug.getState().command("continue");
      if (canDebug()) return startDebugging();
      // Languages without a debugger yet: F5 simply runs.
      showBottom("run");
      void useExecution.getState().execute();
    },
  },
  {
    id: "debug.pause",
    title: "Pause",
    category: "Debug",
    shortcut: "F6",
    enabled: () => inDebugSession() && debugPhase() === "running",
    run: () => useDebug.getState().command("pause"),
  },
  {
    id: "debug.stepOver",
    title: "Step Over",
    category: "Debug",
    shortcut: "F10",
    enabled: () => inDebugSession() && debugPhase() === "paused",
    run: () => useDebug.getState().command("stepOver"),
  },
  {
    id: "debug.stepIn",
    title: "Step Into",
    category: "Debug",
    shortcut: "F11",
    enabled: () => inDebugSession() && debugPhase() === "paused",
    run: () => useDebug.getState().command("stepIn"),
  },
  {
    id: "debug.stepOut",
    title: "Step Out",
    category: "Debug",
    shortcut: "Shift+F11",
    enabled: () => inDebugSession() && debugPhase() === "paused",
    run: () => useDebug.getState().command("stepOut"),
  },
  {
    id: "debug.restart",
    title: "Restart Debugging",
    category: "Debug",
    shortcut: "Mod+Shift+F5",
    enabled: inDebugSession,
    run: () => {
      // Stop the current session, then start a fresh one once it has ended.
      const unsubscribe = useExecution.subscribe((s) => {
        if (!isRunning(s.run)) {
          unsubscribe();
          startDebugging();
        }
      });
      void useExecution.getState().cancel();
    },
  },
  {
    id: "debug.toggleBreakpoint",
    title: "Toggle Breakpoint",
    category: "Debug",
    shortcut: "F9",
    enabled: () => !!useWorkspace.getState().activeFile && canDebug(),
    run: () => {
      const file = useWorkspace.getState().activeFile;
      if (file) useWorkspace.getState().toggleBreakpoint(file, useCursor.getState().line);
    },
  },
  {
    id: "debug.clearBreakpoints",
    title: "Remove All Breakpoints",
    category: "Debug",
    enabled: () => Object.keys(useWorkspace.getState().project?.breakpoints ?? {}).length > 0,
    run: () => useWorkspace.getState().clearBreakpoints(),
  },
  {
    id: "view.debug",
    title: "Show Debug",
    category: "View",
    shortcut: "Mod+Shift+D",
    run: () => {
      const { layout } = useSettings.getState();
      if (layout.bottomOpen && layout.bottomTab === "debug") useSettings.getState().updateLayout({ bottomOpen: false });
      else showBottom("debug");
    },
  },
  {
    id: "run.clearOutput",
    title: "Clear Output",
    category: "Run",
    run: () => useExecution.getState().clearOutput(),
  },
  {
    id: "workbench.commandPalette",
    title: "Show All Commands",
    category: "View",
    shortcut: "Mod+Shift+P",
    run: () => useUI.getState().openPalette("commands"),
  },
  {
    id: "workbench.quickOpen",
    title: "Go to File…",
    category: "Go",
    shortcut: "Mod+P",
    enabled: hasProject,
    run: () => useUI.getState().openPalette("files"),
  },
  {
    id: "project.new",
    title: "New Project…",
    category: "Project",
    shortcut: "Alt+N",
    run: () => useUI.getState().setNewProjectOpen(true),
  },
  {
    id: "project.switch",
    title: "Open Project…",
    category: "Project",
    shortcut: "Mod+Alt+O",
    run: () => useUI.getState().openPalette("projects"),
  },
  {
    id: "project.close",
    title: "Close Project",
    category: "Project",
    enabled: hasProject,
    run: () => useWorkspace.getState().closeProject(),
  },
  {
    id: "project.snapshot",
    title: "Save Snapshot",
    category: "Project",
    enabled: hasProject,
    run: () => void useSnapshots.getState().create(),
  },
  {
    id: "file.save",
    title: "Save",
    category: "File",
    shortcut: "Mod+S",
    enabled: hasProject,
    run: () => void useWorkspace.getState().flush(),
  },
  {
    id: "file.newFile",
    title: "New File…",
    category: "File",
    enabled: hasProject,
    run: () => {
      const active = useWorkspace.getState().activeFile;
      showSide("explorer");
      useUI.getState().requestCreate(active ? parentOf(active) : "", "file");
    },
  },
  {
    id: "file.newFolder",
    title: "New Folder…",
    category: "File",
    enabled: hasProject,
    run: () => {
      showSide("explorer");
      useUI.getState().requestCreate("", "folder");
    },
  },
  {
    id: "file.closeTab",
    title: "Close Editor",
    category: "File",
    shortcut: "Alt+W",
    enabled: () => !!useWorkspace.getState().activeFile,
    run: () => {
      const { activeFile, closeTab } = useWorkspace.getState();
      if (activeFile) closeTab(activeFile);
    },
  },
  {
    id: "file.setEntry",
    title: "Set Active File as Entry",
    category: "File",
    enabled: () => !!useWorkspace.getState().activeFile,
    run: () => {
      const { activeFile, setEntryFile } = useWorkspace.getState();
      if (activeFile) {
        setEntryFile(activeFile);
        toast.success("Entry file updated", activeFile);
      }
    },
  },
  { id: "edit.find", title: "Find", category: "Edit", shortcut: "Mod+F", enabled: hasProject, run: () => editorBridge.trigger("actions.find") },
  {
    id: "edit.replace",
    title: "Replace",
    category: "Edit",
    shortcut: "Mod+H",
    enabled: hasProject,
    run: () => editorBridge.trigger("editor.action.startFindReplaceAction"),
  },
  {
    id: "edit.goToLine",
    title: "Go to Line…",
    category: "Go",
    shortcut: "Mod+G",
    enabled: hasProject,
    run: () => editorBridge.trigger("editor.action.gotoLine"),
  },
  {
    id: "edit.format",
    title: "Format Document",
    category: "Edit",
    shortcut: "Shift+Alt+F",
    enabled: hasProject,
    run: () => editorBridge.trigger("editor.action.formatDocument"),
  },
  {
    id: "edit.toggleComment",
    title: "Toggle Line Comment",
    category: "Edit",
    shortcut: "Mod+/",
    enabled: hasProject,
    run: () => editorBridge.trigger("editor.action.commentLine"),
  },
  {
    id: "view.toggleSidebar",
    title: "Toggle Sidebar",
    category: "View",
    shortcut: "Mod+B",
    run: () => {
      const { layout, updateLayout } = useSettings.getState();
      updateLayout({ sidebarOpen: !layout.sidebarOpen });
      const ui = useUI.getState();
      ui.setDrawer(ui.drawer === "sidebar" ? "none" : "sidebar");
    },
  },
  {
    id: "view.toggleBottomPanel",
    title: "Toggle Panel",
    category: "View",
    shortcut: "Mod+J",
    run: () => {
      const { layout, updateLayout } = useSettings.getState();
      updateLayout({ bottomOpen: !layout.bottomOpen });
      const ui = useUI.getState();
      ui.setDrawer(ui.drawer === "bottom" ? "none" : "bottom");
    },
  },
  { id: "view.explorer", title: "Show Explorer", category: "View", shortcut: "Mod+Shift+E", run: () => showSide("explorer") },
  { id: "view.search", title: "Search in Project", category: "View", shortcut: "Mod+Shift+F", enabled: hasProject, run: () => showSide("search") },
  { id: "view.history", title: "Show Run History", category: "View", shortcut: "Mod+Shift+H", run: () => showSide("history") },
  { id: "view.run", title: "Show Run", category: "View", shortcut: "Alt+4", run: () => showBottom("run") },
  { id: "view.visualize", title: "Show Visualize", category: "View", run: () => showBottom("visualize") },
  { id: "view.problems", title: "Show Problems", category: "View", shortcut: "Mod+Shift+M", run: () => showBottom("problems") },
  { id: "view.input", title: "Show Program Input (stdin)", category: "View", run: () => showBottom("input") },
  { id: "view.resetLayout", title: "Reset Layout", category: "View", run: () => useSettings.getState().resetLayout() },
  {
    id: "prefs.toggleTheme",
    title: "Toggle Light/Dark Theme",
    category: "Preferences",
    run: () => {
      const s = useSettings.getState();
      s.update({ theme: resolveTheme(s.theme) === "dark" ? "light" : "dark" });
    },
  },
  {
    id: "prefs.fontIncrease",
    title: "Increase Editor Font Size",
    category: "Preferences",
    shortcut: "Mod+=",
    run: () => useSettings.getState().update({ fontSize: Math.min(useSettings.getState().fontSize + 1, 24) }),
  },
  {
    id: "prefs.fontDecrease",
    title: "Decrease Editor Font Size",
    category: "Preferences",
    shortcut: "Mod+-",
    run: () => useSettings.getState().update({ fontSize: Math.max(useSettings.getState().fontSize - 1, 10) }),
  },
  {
    id: "prefs.fontReset",
    title: "Reset Editor Font Size",
    category: "Preferences",
    shortcut: "Mod+0",
    run: () => useSettings.getState().update({ fontSize: DEFAULT_SETTINGS.fontSize }),
  },
  {
    id: "prefs.wordWrap",
    title: "Toggle Word Wrap",
    category: "Preferences",
    shortcut: "Alt+Z",
    run: () => useSettings.getState().update({ wordWrap: !useSettings.getState().wordWrap }),
  },
  {
    id: "prefs.minimap",
    title: "Toggle Minimap",
    category: "Preferences",
    run: () => useSettings.getState().update({ minimap: !useSettings.getState().minimap }),
  },
  { id: "prefs.open", title: "Open Settings", category: "Preferences", shortcut: "Mod+,", run: () => useUI.getState().setSettingsOpen(true) },
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return byId.get(id);
}

export function isEnabled(cmd: Command): boolean {
  return cmd.enabled ? cmd.enabled() : true;
}

export function runCommand(id: string): boolean {
  const cmd = byId.get(id);
  if (!cmd || !isEnabled(cmd)) return false;
  cmd.run();
  return true;
}

/** First binding of a command, for display in menus and tooltips. */
export function primaryShortcut(id: string): string | undefined {
  return byId.get(id)?.shortcut?.split(" / ")[0];
}
