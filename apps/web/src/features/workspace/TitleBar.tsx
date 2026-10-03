"use client";

import { Bug, ChevronDown, ClipboardList, Ellipsis, FileDown, Hourglass, Save, Trash2, Link2, Menu, Smartphone, Moon, Play, Search, Settings, Sparkles, Square, Sun, Users, Workflow } from "lucide-react";
import { anyFileIsRunnable, findEntryPoints, getLanguage, runTarget } from "@cw/shared";
import { IconButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { DropdownMenu, type MenuEntry } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { canDebug, canVisualize, getCommand, isEnabled, primaryShortcut, runCommand } from "@/features/commands/registry";
import { FileIcon, ProjectBadge } from "@/features/explorer/file-icon";
import { isOwnRun, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useResolvedTheme, useSettings } from "@/features/settings/store";
import { useMediaQuery } from "@/lib/use-media";
import { cn } from "@/lib/cn";
import { Brand } from "./Logo";
import { LiveButton } from "@/features/live/LiveUI";
import { useRestriction } from "@/features/interview/restrict";
import { InterviewClock } from "@/features/interview/Clock";
import { useLive } from "@/features/live/store";
import { RunSubmit } from "@/features/interview/CandidateTests";
import { CameraChip } from "@/features/interview/CameraView";
import { ExportButton } from "@/features/export/ExportUI";

/** Builds menu entries straight from the command registry so menus never drift from shortcuts. */
function fromCommands(ids: (string | "-")[]): MenuEntry[] {
  return ids.map((id) => {
    if (id === "-") return { kind: "separator" as const };
    const cmd = getCommand(id)!;
    return { label: cmd.title, shortcut: primaryShortcut(id), disabled: !isEnabled(cmd), onSelect: () => runCommand(id) };
  });
}

const MENUS: { label: string; items: (string | "-")[] }[] = [
  { label: "File", items: ["project.new", "project.switch", "-", "file.newFile", "file.newFolder", "file.import", "file.importFolder", "-", "file.save", "project.snapshot", "-", "file.downloadPdf", "file.shareLink", "project.transfer", "-", "file.setEntry", "file.closeTab", "project.close"] },
  { label: "Edit", items: ["edit.find", "edit.replace", "-", "edit.toggleComment", "edit.format", "edit.goToLine"] },
  { label: "View", items: ["workbench.commandPalette", "workbench.quickOpen", "-", "view.explorer", "view.search", "view.history", "-", "view.run", "view.debug", "view.visualize", "view.problems", "view.input", "-", "view.toggleSidebar", "view.toggleBottomPanel", "view.resetLayout"] },
  { label: "Run", items: ["run.execute", "run.currentFile", "debug.startOrContinue", "run.visualize", "run.cancel", "-", "run.clearOutput", "view.input"] },
  {
    label: "Debug",
    items: ["debug.startOrContinue", "debug.pause", "debug.stepOver", "debug.stepIn", "debug.stepOut", "-", "debug.restart", "run.cancel", "-", "debug.toggleBreakpoint", "debug.clearBreakpoints"],
  },
  { label: "Settings", items: ["prefs.open", "-", "prefs.toggleTheme", "prefs.wordWrap", "prefs.minimap", "-", "prefs.fontIncrease", "prefs.fontDecrease", "prefs.fontReset"] },
];

/** In an interview the right-hand panel holds the interview (the interviewer's tools, or the candidate's problem). */
function InterviewButton() {
  const open = useSettings((s) => s.layout.assistantOpen);
  const owner = useLive((s) => s.role === "owner");
  return (
    <button
      type="button"
      aria-pressed={open}
      onClick={() => useSettings.getState().updateLayout({ assistantOpen: !open })}
      className={cn(
        "flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors",
        open ? "border-accent/60 bg-accent/15 text-fg" : "border-line-strong/80 text-fg-muted hover:text-fg",
      )}
    >
      <ClipboardList className="size-3.5 text-accent-ink" />
      {owner ? "Interview" : "Problem"}
      <InterviewClock className="text-xs" />
    </button>
  );
}

function AssistantButton() {
  const open = useSettings((s) => s.layout.assistantOpen);
  const interview = useLive((s) => !!s.interview);
  if (interview) return <InterviewButton />;
  return (
    <Tooltip content="AI Assistant" shortcut="Mod+Shift+A">
      <button
        type="button"
        aria-label="AI Assistant"
        aria-pressed={open}
        onClick={() => runCommand("assistant.toggle")}
        className={cn(
          "group rounded-full p-px transition-shadow",
          open ? "bg-accent" : "bg-line-strong hover:bg-accent",
        )}
      >
        <span
          className={cn(
            "flex h-[30px] items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors",
            open ? "bg-accent-soft text-fg" : "bg-canvas text-fg-muted group-hover:text-fg",
          )}
        >
          <Sparkles className="size-3.5 text-accent-ink" />
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
  const activeFile = useWorkspace((s) => s.activeFile);
  const run = useExecution((s) => s.run);
  const running = isOwnRun(run);
  const lang = getLanguage(project.language);
  // What Run starts: the program in the editor, else the project's entry file.
  const target = runTarget(project, activeFile).entry;
  // Compiled languages list their main functions; interpreted ones can run any source file.
  const runnable = !lang
    ? []
    : anyFileIsRunnable(lang.id)
      ? project.files.filter((f) => lang.extensions.some((e) => f.path.toLowerCase().endsWith(e))).map((f) => ({ file: f.path, label: f.path }))
      : findEntryPoints(lang.id, project.files).map((e) => ({ file: e.file, label: e.mainClass ? `${e.label}  (${e.file})` : e.file }));

  return (
    <div className="flex h-[34px] shrink-0 items-center gap-0.5 rounded-[10px] border border-line-strong/80 bg-surface-2 p-[3px] shadow-[0_1px_2px_rgb(0_0_0/0.06)] [[data-touch]_&]:h-[42px] [[data-touch]_&]:rounded-[12px]">
      <DropdownMenu
        align="end"
        entries={[
          { kind: "label", label: "Program to run" },
          ...(runnable.length
            ? runnable.map((r) => ({
                label: r.label,
                checked: r.file === target,
                // Run starts what is in the editor, so choosing a program opens it.
                onSelect: () => {
                  useWorkspace.getState().setEntryFile(r.file);
                  useWorkspace.getState().openFile(r.file);
                },
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
            <FileIcon name={target || "file"} />
            <span className="hidden truncate sm:inline">{target ? target.split("/").pop() : "No entry file"}</span>
            <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
          </button>
        }
      />
      <Tooltip content="Run" shortcut="Mod+Enter">
        <button
          aria-label="Run program"
          disabled={running}
          onClick={() => runCommand("run.execute")}
          className="flex h-full items-center gap-1.5 rounded-[7px] bg-gradient-to-b from-[#29a35d] to-[#1f8f4e] px-3 text-[13px] font-medium text-white transition-[filter,transform] hover:brightness-110 active:scale-[0.97] disabled:opacity-45"
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
        <IconButton label="Visualize execution" shortcut="Mod+Alt+Enter" disabled={running} onClick={() => runCommand("run.visualize")} className="size-7 rounded-[7px] text-accent-ink max-sm:hidden">
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

/** Phones and tablets: what does not fit in the title bar, in one menu. */
function PhoneMenu({ interview }: { interview: boolean }) {
  const theme = useResolvedTheme();
  // A tablet's title bar already has the buttons a phone's has no room for.
  const phone = useMediaQuery("(max-width: 639px)");
  const entries: MenuEntry[] = [
    ...(phone ? [{ label: "Share live session", icon: <Users />, onSelect: () => useLive.getState().setPanelOpen(true) }] : []),
    { label: "Download code…", icon: <FileDown />, onSelect: () => runCommand("file.downloadPdf") },
    { label: "Share a link to this code", icon: <Link2 />, onSelect: () => runCommand("file.shareLink") },
    { label: "Move projects to another device", icon: <Smartphone />, onSelect: () => runCommand("project.transfer") },
    ...(phone
      ? [
          ...(interview ? [{ label: "Interview mode", icon: <ClipboardList />, onSelect: () => runCommand("interview.start") }] : []),
          { label: "Search files and actions", icon: <Search />, onSelect: () => runCommand("workbench.quickOpen") },
          { label: theme === "dark" ? "Light theme" : "Dark theme", icon: theme === "dark" ? <Sun /> : <Moon />, onSelect: () => runCommand("prefs.toggleTheme") },
          { label: "Open settings", icon: <Settings />, onSelect: () => runCommand("prefs.open") },
        ]
      : []),
    { kind: "separator" },
    ...MENUS.map((m) => ({ kind: "submenu" as const, label: m.label, entries: fromCommands(m.items) })),
  ];
  return (
    <span>
      <DropdownMenu
        align="end"
        touch
        inline
        entries={entries}
        trigger={
          <button aria-label="More" className="flex size-9 items-center justify-center rounded-full text-fg-muted hover:bg-hover data-[state=open]:bg-active">
            <Ellipsis className="size-5" />
          </button>
        }
      />
    </span>
  );
}

export function TitleBar({ compact }: { compact: boolean }) {
  const project = useWorkspace((s) => s.project);
  const restricted = useRestriction((s) => s.restricted);
  const interviewActive = useLive((s) => !!s.interview);
  const projects = useWorkspace((s) => s.projects);
  // Re-render menus when layout toggles so their enabled state is fresh.
  useSettings((s) => s.layout);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1 border-b border-line bg-canvas px-2.5 [[data-touch]_&]:h-14 [[data-touch]_&]:pt-[env(safe-area-inset-top)]">
      <button
        // Going home would leave the interview.
        disabled={restricted}
        onClick={() => useWorkspace.getState().closeProject()}
        className="flex h-9 items-center rounded-[9px] pl-1 pr-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="Home"
      >
        <Brand name={!compact || !project} />
      </button>

      {(!compact || !project) && !restricted && (
        <DropdownMenu
          touch={compact}
          inline={compact}
          entries={MENUS.map((m) => ({ kind: "submenu" as const, label: m.label, entries: fromCommands(m.items) }))}
          trigger={
            <button aria-label="Main menu" className="flex size-8 items-center justify-center rounded-[6px] text-fg-muted hover:bg-hover data-[state=open]:bg-active">
              <Menu className="size-[18px]" />
            </button>
          }
        />
      )}

      {project && restricted && <span className="ml-1 min-w-0 truncate text-[13.5px] font-semibold text-fg">{project.name}</span>}
      {project && !restricted && (
        <>
          {!compact && <span aria-hidden className="mx-1 h-5 w-px bg-line-strong" />}
          <DropdownMenu
            entries={[
              { kind: "label", label: "Recent projects" },
              ...projects
                .filter((p) => !p.untouched || p.id === project.id)
                .slice(0, 10)
                .map((p) => ({
                label: p.interview ? `Interview: ${p.interview.title}${p.interview.candidate ? ` (${p.interview.candidate})` : ""}` : p.name,
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
                className="flex h-8 min-w-0 max-w-[28vw] sm:min-w-24 shrink items-center gap-2 rounded-[8px] px-1.5 text-[13.5px] font-semibold text-fg transition-colors hover:bg-hover data-[state=open]:bg-active [[data-touch]_&]:h-10"
              >
                <ProjectBadge name={project.name} className="size-6 rounded-[5px] text-[11px]" />
                <span className="truncate">{project.name}</span>
                <ChevronDown className="hidden size-3.5 shrink-0 text-fg-subtle sm:block" />
              </button>
            }
          />
          {project.temporary && (
            <DropdownMenu
              touch={compact}
              entries={[
                { kind: "label", label: "Not saved: erased when you close it" },
                { label: "Keep this project", icon: <Save />, onSelect: () => void useWorkspace.getState().keepTemporary() },
                { label: "Close and erase", icon: <Trash2 />, danger: true, onSelect: () => runCommand("project.close") },
              ]}
              trigger={
                <button aria-label="Temporary project" title="Temporary: not saved, erased when you close it" className="ml-1 flex h-[26px] shrink-0 items-center gap-1 rounded-full border border-accent/50 bg-accent-soft/50 px-2 text-xs font-medium text-fg hover:bg-accent-soft data-[state=open]:bg-accent-soft">
                  <Hourglass className="size-3 text-accent-ink" />
                  {/* Where the search box sits in the middle of the bar, the mark alone leaves it room. */}
                  <span className="hidden sm:inline xl:hidden 2xl:inline">Temporary</span>
                </button>
              }
            />
          )}
        </>
      )}

      {!compact && !restricted && (
        <div className="pointer-events-none absolute inset-x-0 hidden justify-center xl:flex">
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

      <div className={cn("relative ml-auto flex items-center gap-1", compact ? "shrink-0" : "min-w-0")}>
        {project && !restricted && <RunControls />}
        {project && restricted && compact && <RunSubmit />}
        {project && restricted && <InterviewClock className="mx-2 text-[13px]" />}
        {project && !restricted && (
          <span className={cn("ml-1.5", compact && "hidden sm:inline")}>
            <LiveButton />
          </span>
        )}
        {project && !restricted && !compact && <ExportButton />}
        {project && restricted && <CameraChip />}
        {project && !compact && !restricted && (
          <span className="ml-1.5 mr-1">
            <AssistantButton />
          </span>
        )}
        {!interviewActive && !restricted && (
          <button
            type="button"
            aria-label="Interview mode"
            onClick={() => runCommand("interview.start")}
            className={cn(
              "mr-1 h-[30px] items-center gap-1.5 rounded-full border border-line-strong/80 px-2.5 text-[13px] lg:px-3 font-medium text-fg-muted transition-colors hover:border-accent/60 hover:text-fg",
              compact && project ? "hidden sm:flex" : "flex",
            )}
          >
            <ClipboardList className="size-3.5 text-accent-ink" />
            <span className={cn("hidden lg:inline", compact && "sm:inline")}>Interview</span>
          </button>
        )}
        {/* Where the centred search box does not fit. */}
        <span className={cn(restricted ? "hidden" : compact ? (project ? "hidden sm:inline-flex" : "inline-flex") : "inline-flex xl:hidden")}>
          <IconButton label="Search everywhere" shortcut="Mod+Shift+P" onClick={() => runCommand(project ? "workbench.quickOpen" : "workbench.commandPalette")}>
            <Search />
          </IconButton>
        </span>
        <span className={cn(compact && project && "hidden sm:inline-flex")}>
          <ThemeToggle />
        </span>
        <span className={cn(compact && project && "hidden sm:inline-flex")}>
          <IconButton label="Settings" shortcut="Mod+," onClick={() => runCommand("prefs.open")}>
            <Settings />
          </IconButton>
        </span>
        {compact && project && !restricted && <PhoneMenu interview={!interviewActive} />}
        {compact && project && restricted && (
          <span className="sm:hidden">
            <ThemeToggle />
          </span>
        )}
      </div>
    </header>
  );
}
