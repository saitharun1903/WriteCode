"use client";

import { CircleCheck, CircleX, Keyboard, Loader2, Minus, OctagonAlert, Pause } from "lucide-react";
import { basename } from "@cw/shared";
import { IconButton } from "@/components/ui/button";
import { DebugToolWindow } from "@/features/debug/DebugPanel";
import { VisualizerPanel } from "@/features/visualize/VisualizerPanel";
import { useDebug } from "@/features/debug/store";
import { FileIcon } from "@/features/explorer/file-icon";
import { InputPanel } from "@/features/execution/InputPanel";
import { RunMetrics, RunToolWindow } from "@/features/execution/OutputPanel";
import { ProblemsPanel } from "@/features/execution/ProblemsPanel";
import { STATUS_META } from "@/features/execution/status";
import { isRunning, useExecution } from "@/features/execution/store";
import { useSettings, type BottomTab } from "@/features/settings/store";
import { cn } from "@/lib/cn";

const TITLES: Record<BottomTab, string> = {
  run: "Run",
  debug: "Debug",
  visualize: "Visualize",
  problems: "Problems",
  input: "Program Input",
};

const toneClass = {
  neutral: "text-fg-subtle",
  running: "text-fg-subtle",
  input: "text-warning",
  success: "text-success",
  danger: "text-danger",
  warning: "text-warning",
};

/** The session tab next to the tool window title: entry file, state icon and state label. */
function SessionTab() {
  const run = useExecution((s) => s.run);
  const paused = useDebug((s) => s.phase === "paused");
  if (!run) return null;
  const running = isRunning(run);
  const meta = STATUS_META[run.error ? "SYSTEM_ERROR" : run.status];
  const label = run.error ? "Failed to start" : running && run.mode === "debug" && paused ? "Paused" : meta.label;
  const tone = running && run.mode === "debug" && paused ? "warning" : meta.tone;
  const Icon = running && run.mode === "debug" && paused ? Pause : run.status === "WAITING_FOR_INPUT" ? Keyboard : running ? Loader2 : meta.tone === "success" ? CircleCheck : meta.tone === "danger" ? CircleX : meta.tone === "warning" ? OctagonAlert : null;

  return (
    <div className="flex h-full min-w-0 items-center gap-2">
      <span className="relative flex h-full items-center gap-1.5 px-2 text-sm text-fg">
        <FileIcon name={run.entry} />
        <span className="truncate">{basename(run.entry)}</span>
        <span className="absolute inset-x-1.5 bottom-0 h-0.5 rounded-full bg-accent" />
      </span>
      <span className={cn("flex items-center gap-1 text-sm", toneClass[tone])}>
        {Icon && <Icon className={cn("size-3.5", running && !paused && run.status !== "WAITING_FOR_INPUT" && "animate-spin")} />}
        {label}
      </span>
    </div>
  );
}

export function BottomPanel({ onClose }: { onClose: () => void }) {
  const tab = useSettings((s) => s.layout.bottomTab);

  return (
    <section aria-label={TITLES[tab]} className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <h2 className="text-sm font-semibold text-fg">{TITLES[tab]}</h2>
        {(tab === "run" || tab === "debug" || tab === "visualize") && <SessionTab />}
        <div className="ml-auto flex items-center gap-2">
          {tab === "run" && <RunMetrics />}
          <IconButton label="Hide" shortcut="Mod+J" size="sm" onClick={onClose}>
            <Minus />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "run" && <RunToolWindow />}
        {tab === "debug" && <DebugToolWindow />}
        {tab === "visualize" && <VisualizerPanel />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "input" && <InputPanel />}
      </div>
    </section>
  );
}
