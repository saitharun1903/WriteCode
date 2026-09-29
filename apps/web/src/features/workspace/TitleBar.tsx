"use client";

import { Bug, ChevronDown, Menu, Moon, Play, Search, Settings, Sparkles, Square, Sun, Workflow } from "lucide-react";
import { PRODUCT, anyFileIsRunnable, findEntryPoints, getLanguage } from "@cw/shared";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { DropdownMenu, type MenuEntry } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { canDebug, canVisualize, getCommand, isEnabled, primaryShortcut, runCommand } from "@/features/commands/registry";
import { FileIcon, ProjectBadge } from "@/features/explorer/file-icon";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useResolvedTheme, useSettings } from "@/features/settings/store";
import { cn } from "@/lib/cn";
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
  { label: "File", items: ["project.new", "project.switch", "-", "file.newFile", "file.newFolder", "file.import", "file.importFolder", "-", "file.save", "project.snapshot", "-", "file.setEntry", "file.closeTab", "project.close"] },
  { label: "Edit", items: ["edit.find", "edit.replace", "-", "edit.toggleComment", "edit.format", "edit.goToLine"] },
  { label: "View", items: ["workbench.commandPalette", "workbench.quickOpen", "-", "view.explorer", "view.search", "view.history", "-", "view.run", "view.debug", "view.visualize", "view.problems", "view.input", "-", "view.toggleSidebar", "view.toggleBottomPanel", "view.resetLayout"] },
  { label: "Run", items: ["run.execute", "run.currentFile", "debug.startOrContinue", "run.visualize", "run.cancel", "-", "run.clearOutput", "view.input"] },
  {
    label: "Debug",
    items: ["debug.startOrContinue", "debug.pause", "debug.stepOver", "debug.stepIn", "debug.stepOut", "-", "debug.restart", "run.cancel", "-", "debug.toggleBreakpoint", "debug.clearBreakpoints"],
  },
  { label: "Settings", items: ["prefs.open", "-", "prefs.toggleTheme", "prefs.wordWrap", "prefs.minimap", "-", "prefs.fontIncrease", "prefs.fontDecrease", "prefs.fontReset"] },
];

function AssistantButton() {
  const open = useSettings((s) => s.layout.assistantOpen);
  return (
    <Tooltip content="AI Assistant" shortcut="Mod+Shift+A">
      <button
        type="button"
        aria-label="AI Assistant"
        aria-pressed={open}
        onClick={() => runCommand("assistant.toggle")}
        className={cn(
          "group rounded-full p-px transition-shadow",
          open
            ? "bg-gradient-to-r from-[#6d8cff] via-[#8a7cf5] to-[#c26cea] shadow-[0_6px_18px_-8px_#8a7cf5]"
            : "bg-gradient-to-r from-[#6d8cff]/55 via-[#8a7cf5]/55 to-[#c26cea]/55 hover:from-[#6d8cff] hover:via-[#8a7cf5] hover:to-[#c26cea]",
        )}
      >
        <span
          className={cn(
            "flex h-[30px] items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
            open ? "bg-[color-mix(in_srgb,var(--canvas)_82%,#8a7cf5)] text-fg" : "bg-canvas text-fg-muted group-hover:text-fg",
          )}
        >
          <Sparkles className="size-3.5 text-[#8a7cf5]" />
          Ask AI
        </span>
      </button>
    </Tooltip>
  );
}

function ThemeToggle() {
  const dark = useResolvedTheme() === "dark";
  return (
    <IconButton label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => runCommand("prefs.toggleTheme")}>
      {dark ? <Sun /> : <Moon />}
    </IconButton>
  );
}

/** Grouped run controls: run configuration, Run, Debug and Stop in one capsule. */
function RunControls() {
  const project = useWorkspace((s) => s.project)!;
  const run = useExecution((s) => s.run);
  const running = isRunning(run);
  const lang = getLanguage(project.language);
  // Compiled languages list their main functions; interpreted ones can run any source file.
  const runnable = !lang
    ? []
    : anyFileIsRunnable(lang.id)
      ? project.files.filter((f) => lang.extensions.some((e) => f.path.toLowerCase().endsWith(e))).map((f) => ({ file: f.path, label: f.path }))
      : findEntryPoints(lang.id, project.files).map((e) => ({ file: e.file, label: e.mainClass ? `${e.label}  (${e.file})` : e.file }));

  return (
    <div className="flex h-[34px] items-center gap-0.5 rounded-[10px] border border-line-strong/80 bg-surface-2 p-[3px] shadow-[0_1px_2px_rgb(0_0_0/0.06)]">
      <DropdownMenu
        align="end"
        entries={[
          { kind: "label", label: "Entry point" },
          ...(runnable.length
            ? runnable.map((r) => ({
                label: r.label,
                checked: r.file === project.entryFile,
                onSelect: () => useWorkspace.getState().setEntryFile(r.file),
              }))
            : [{ label: anyFileIsRunnable(project.language) ? `No ${lang?.name ?? ""} files` : "No main function found", disabled: true, onSelect: () => {} }]),
          { kind: "separator" },
          { label: "Program input (stdin)…", onSelect: () => runCommand("view.input") },
        ]}
        trigger={
          <button
            aria-label="Run configuration"
            className="flex h-full max-w-48 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-fg transition-colors hover:bg-hover data-[state=open]:bg-active"
          >
            <FileIcon name={project.entryFile || "file"} />
            <span className="hidden truncate sm:inline">{project.entryFile ? project.entryFile.split("/").pop() : "No entry file"}</span>
            <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
          </button>
        }
      />
      <Tooltip content="Run" shortcut="Mod+Enter">
        <button
          aria-label="Run program"
          disabled={running}
          onClick={() => runCommand("run.execute")}
          className="flex h-full items-center gap-1.5 rounded-[7px] bg-gradient-to-b from-[#29a35d] to-[#1f8f4e] px-3 text-[13px] font-medium text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18),0_2px_6px_-2px_rgb(31_143_78/0.6)] transition-[filter,transform] hover:brightness-110 active:scale-[0.97] disabled:opacity-45"
        >
          <Play className="size-3.5 fill-current" />
          Run
        </button>
      </Tooltip>
      {canDebug() && (
        <IconButton label="Debug program" shortcut="F5" disabled={running} onClick={() => runCommand("debug.startOrContinue")} className="size-7 rounded-[7px] text-success">
          <Bug />
        </IconButton>
      )}
      {canVisualize() && (
        <IconButton label="Visualize execution" shortcut="Mod+Alt+Enter" disabled={running} onClick={() => runCommand("run.visualize")} className="size-7 rounded-[7px] text-accent">
          <Workflow />
        </IconButton>
      )}
      {running && (
        <IconButton label="Stop program" shortcut="Shift+F5" onClick={() => runCommand("run.cancel")} className="size-7 rounded-[7px] text-danger animate-fade">
          <Square className="fill-current" />
        </IconButton>
      )}
    </div>
  );
}

export function TitleBar({ compact }: { compact: boolean }) {
  const project = useWorkspace((s) => s.project);
  const projects = useWorkspace((s) => s.projects);
  // Re-render menus when layout toggles so their enabled state is fresh.
  useSettings((s) => s.layout);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1 border-b border-line bg-canvas px-2.5">
      <button
        onClick={() => useWorkspace.getState().closeProject()}
        className="flex h-8 items-center gap-2 rounded-[6px] pl-1 pr-2 hover:bg-hover"
        aria-label="Home"
      >
        <LogoMark className="size-6" />
        {!compact && <span className="text-[15px] font-semibold tracking-tight text-fg">{PRODUCT.name}</span>}
      </button>

      {(!compact || !project) && (
        <DropdownMenu
          entries={MENUS.map((m) => ({ kind: "submenu" as const, label: m.label, entries: fromCommands(m.items) }))}
          trigger={
            <button aria-label="Main menu" className="flex size-8 items-center justify-center rounded-[6px] text-fg-muted hover:bg-hover data-[state=open]:bg-active">
              <Menu className="size-[18px]" />
            </button>
          }
        />
      )}

      {project && (
        <>
          {!compact && <span aria-hidden className="mx-1 h-5 w-px bg-line-strong" />}
          <DropdownMenu
            entries={[
              { kind: "label", label: "Recent projects" },
              ...projects
                .filter((p) => !p.untouched || p.id === project.id)
                .slice(0, 10)
                .map((p) => ({
                label: p.name,
                checked: p.id === project.id,
                onSelect: () => void useWorkspace.getState().openProject(p.id),
              })),
              { kind: "separator" },
              { label: "Open project…", shortcut: primaryShortcut("project.switch"), onSelect: () => runCommand("project.switch") },
              { label: "New project…", shortcut: primaryShortcut("project.new"), onSelect: () => runCommand("project.new") },
              { label: "Close project", onSelect: () => runCommand("project.close") },
            ]}
            trigger={
              <button
                aria-label={`Project: ${project.name}`}
                className="flex h-8 min-w-0 max-w-[28vw] items-center gap-2 rounded-[8px] px-1.5 text-[13.5px] font-semibold text-fg transition-colors hover:bg-hover data-[state=open]:bg-active"
              >
                <ProjectBadge name={project.name} className="size-6 rounded-[5px] text-[11px]" />
                <span className="hidden truncate sm:inline">{project.name}</span>
                <ChevronDown className="hidden size-3.5 shrink-0 text-fg-subtle sm:block" />
              </button>
            }
          />
        </>
      )}

      {!compact && (
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          <button
            onClick={() => runCommand(project ? "workbench.quickOpen" : "workbench.commandPalette")}
            className="pointer-events-auto flex h-[34px] w-[min(440px,32vw)] items-center gap-2.5 rounded-[10px] border border-line-strong/70 bg-surface-2 px-3 text-[13px] text-fg-subtle shadow-[inset_0_1px_2px_rgb(0_0_0/0.05)] transition-colors hover:border-accent/50 hover:text-fg-muted"
          >
            <Search className="size-4 text-fg-faint" />
            <span className="truncate">{project ? "Search files and actions" : "Search actions"}</span>
            <Kbd shortcut={project ? "Mod+P" : "Mod+Shift+P"} className="ml-auto" />
          </button>
        </div>
      )}

      <div className="relative ml-auto flex min-w-0 items-center gap-1">
        {project && <RunControls />}
        {project && !compact && (
          <span className="ml-2 mr-1">
            <AssistantButton />
          </span>
        )}
        {compact && (
          <IconButton label="Search everywhere" shortcut="Mod+Shift+P" onClick={() => runCommand("workbench.commandPalette")}>
            <Search />
          </IconButton>
        )}
        <span className={cn(compact && project && "hidden sm:inline-flex")}>
          <ThemeToggle />
        </span>
        <IconButton label="Settings" shortcut="Mod+," onClick={() => runCommand("prefs.open")}>
          <Settings />
        </IconButton>
      </div>
    </header>
  );
}
