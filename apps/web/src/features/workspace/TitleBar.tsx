"use client";

import { Bug, ChevronDown, Command, Menu, Play, Square } from "lucide-react";
import { getLanguage } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { DropdownMenu, type MenuEntry } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { canDebug, getCommand, isEnabled, primaryShortcut, runCommand } from "@/features/commands/registry";
import { DebugControls } from "@/features/debug/DebugControls";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { useUI } from "./ui-store";
import { LogoMark } from "./Logo";

/** Builds menu entries straight from the command registry so menus never drift from shortcuts. */
function fromCommands(ids: (string | "-")[]): MenuEntry[] {
  return ids.map((id) => {
    if (id === "-") return { kind: "separator" as const };
    const cmd = getCommand(id)!;
    return { label: cmd.title, shortcut: primaryShortcut(id), disabled: !isEnabled(cmd), onSelect: () => runCommand(id) };
  });
}

const MENUS: { label: string; items: (string | "-")[] }[] = [
  { label: "File", items: ["project.new", "project.switch", "-", "file.newFile", "file.newFolder", "-", "file.save", "project.snapshot", "-", "file.setEntry", "file.closeTab", "project.close"] },
  { label: "Edit", items: ["edit.find", "edit.replace", "-", "edit.toggleComment", "edit.format"] },
  { label: "View", items: ["workbench.commandPalette", "workbench.quickOpen", "-", "view.explorer", "view.search", "view.history", "-", "view.toggleSidebar", "view.toggleBottomPanel", "view.problems", "view.input", "-", "prefs.toggleTheme", "prefs.wordWrap", "prefs.minimap", "view.resetLayout"] },
  { label: "Run", items: ["run.execute", "run.cancel", "-", "run.clearOutput", "view.input"] },
  {
    label: "Debug",
    items: ["debug.startOrContinue", "debug.pause", "debug.stepOver", "debug.stepIn", "debug.stepOut", "-", "debug.restart", "run.cancel", "-", "debug.toggleBreakpoint", "debug.clearBreakpoints", "view.debug"],
  },
];

export function TitleBar({ compact }: { compact: boolean }) {
  const project = useWorkspace((s) => s.project);
  const projects = useWorkspace((s) => s.projects);
  const run = useExecution((s) => s.run);
  const running = isRunning(run);
  // Re-render menus when layout toggles so their enabled state is fresh.
  useSettings((s) => s.layout);

  const lang = project ? getLanguage(project.language) : undefined;

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-canvas px-2">
      {compact && project && (
        <IconButton label="Explorer" onClick={() => useUI.getState().setDrawer(useUI.getState().drawer === "sidebar" ? "none" : "sidebar")}>
          <Menu />
        </IconButton>
      )}
      <button
        onClick={() => useWorkspace.getState().closeProject()}
        className="flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-hover"
        aria-label="Home"
        title="Home"
      >
        <LogoMark />
      </button>

      {!compact && (
        <nav aria-label="Main menu" className="flex items-center">
          {MENUS.map((m) => (
            <DropdownMenu
              key={m.label}
              entries={fromCommands(m.items)}
              trigger={
                <button className="h-7 rounded-sm px-2 text-sm text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg">
                  {m.label}
                </button>
              }
            />
          ))}
        </nav>
      )}

      {project && (
        <div className="mx-auto flex min-w-0 items-center">
          <DropdownMenu
            align="center"
            entries={[
              { kind: "label", label: "Projects" },
              ...projects.slice(0, 8).map((p) => ({
                label: p.name,
                onSelect: () => void useWorkspace.getState().openProject(p.id),
              })),
              { kind: "separator" },
              { label: "All projects…", shortcut: primaryShortcut("project.switch"), onSelect: () => runCommand("project.switch") },
              { label: "New project…", shortcut: primaryShortcut("project.new"), onSelect: () => runCommand("project.new") },
            ]}
            trigger={
              <button className="flex h-7 min-w-0 max-w-[40vw] items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-sm text-fg hover:border-line-strong data-[state=open]:border-line-strong">
                <span className="truncate">{project.name}</span>
                {lang && <span className="hidden shrink-0 text-xs text-fg-subtle sm:inline">{lang.name}</span>}
                <ChevronDown className="size-3 shrink-0 text-fg-subtle" />
              </button>
            }
          />
        </div>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {!compact && (
          <Tooltip content="Command palette" shortcut="Mod+Shift+P">
            <button
              onClick={() => runCommand("workbench.commandPalette")}
              aria-label="Command palette"
              className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <Command className="size-3.5" />
            </button>
          </Tooltip>
        )}
        {project && running && run?.mode === "debug" && <DebugControls />}
        {project && running && run?.mode !== "debug" && (
          <Button variant="secondary" aria-label="Stop program" icon={<Square className="size-3 fill-current" />} onClick={() => runCommand("run.cancel")}>
            Stop
          </Button>
        )}
        {project && !running && (
          <>
            {canDebug() && (
              <Tooltip content="Start debugging" shortcut="F5">
                <Button variant="secondary" aria-label="Debug program" icon={<Bug className="size-3.5" />} onClick={() => runCommand("debug.startOrContinue")}>
                  {!compact && "Debug"}
                </Button>
              </Tooltip>
            )}
            <Tooltip content="Run entry file" shortcut="Mod+Enter">
              <Button variant="primary" aria-label="Run program" icon={<Play className="size-3 fill-current" />} onClick={() => runCommand("run.execute")}>
                Run
              </Button>
            </Tooltip>
          </>
        )}
      </div>
    </header>
  );
}
