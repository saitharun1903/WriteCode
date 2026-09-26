"use client";

import { ArrowDownToDot, ArrowUpFromDot, Pause, Play, Redo2, RotateCcw, Square } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { primaryShortcut, runCommand } from "@/features/commands/registry";
import { useDebug } from "./store";

/** Title-bar controls shown while a debug session is active. */
export function DebugControls() {
  const phase = useDebug((s) => s.phase);
  const paused = phase === "paused";
  const running = phase === "running";

  const btn = (id: string, label: string, icon: React.ReactNode, enabled: boolean, className?: string) => (
    <IconButton label={label} shortcut={primaryShortcut(id)} disabled={!enabled} onClick={() => runCommand(id)} className={className}>
      {icon}
    </IconButton>
  );

  return (
    <div role="toolbar" aria-label="Debug controls" className="flex items-center gap-0.5 rounded-md border border-line bg-surface px-0.5">
      {paused
        ? btn("debug.startOrContinue", "Continue", <Play className="fill-current" />, true, "text-success hover:text-success")
        : btn("debug.pause", "Pause", <Pause className="fill-current" />, running)}
      {btn("debug.stepOver", "Step Over", <Redo2 />, paused)}
      {btn("debug.stepIn", "Step Into", <ArrowDownToDot />, paused)}
      {btn("debug.stepOut", "Step Out", <ArrowUpFromDot />, paused)}
      <span className="mx-0.5 h-4 w-px bg-line" />
      {btn("debug.restart", "Restart", <RotateCcw />, true)}
      {btn("run.cancel", "Stop", <Square className="fill-current text-danger" />, true)}
    </div>
  );
}
