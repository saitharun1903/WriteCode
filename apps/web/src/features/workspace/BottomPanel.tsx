"use client";

import dynamic from "next/dynamic";

import { CircleCheck, CircleX, Keyboard, Loader2, Minus, OctagonAlert, Pause } from "lucide-react";
import { basename, getLanguage } from "@cw/shared";
import { IconButton } from "@/components/ui/button";
import { Spinner } from "@/components/ui/primitives";
import { useDebug } from "@/features/debug/store";
import { FileIcon } from "@/features/explorer/file-icon";
import { InputPanel } from "@/features/execution/InputPanel";
import { RunMetrics, RunToolWindow } from "@/features/execution/OutputPanel";
import { ProblemsPanel } from "@/features/execution/ProblemsPanel";
import { STATUS_META } from "@/features/execution/status";
import { isRunning, useExecution } from "@/features/execution/store";
import { usePreview } from "@/features/preview/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings, type BottomTab } from "@/features/settings/store";
import { cn } from "@/lib/cn";

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

// Heavier tool windows download the first time they are opened, keeping the first page load small.
const DebugToolWindow = dynamic(() => import("@/features/debug/DebugPanel").then((m) => m.DebugToolWindow), { ssr: false, loading: Loading });
const VisualizerPanel = dynamic(() => import("@/features/visualize/VisualizerPanel").then((m) => m.VisualizerPanel), { ssr: false, loading: Loading });
const TestsPanel = dynamic(() => import("@/features/tests/TestsPanel").then((m) => m.TestsPanel), { ssr: false, loading: Loading });

const TITLES: Record<BottomTab, string> = {
  run: "Run",
  debug: "Debug",
  visualize: "Visualize",
  tests: "Tests",
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
function SessionTab({ tab }: { tab: BottomTab }) {
  const run = useExecution((s) => s.run);
  const paused = useDebug((s) => s.phase === "paused");
  // A plain run's status belongs on the Run tab only, not on Debug or Visualize.
  if (!run || run.mode !== tab) return null;
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
  // A project that runs in the browser has no console here: its page, and what the page logs, are in the preview.
  const preview = useWorkspace((s) => !!s.project && !!getLanguage(s.project.language)?.preview) && tab === "run";
  const title = TITLES[tab];

  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {!preview && (tab === "run" || tab === "debug" || tab === "visualize") && <SessionTab tab={tab} />}
        <div className="ml-auto flex items-center gap-2">
          {tab === "run" && !preview && <RunMetrics />}
          <IconButton label="Hide" shortcut="Mod+J" size="sm" onClick={onClose}>
            <Minus />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === "run" &&
          (preview ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-subtle">
              <p>This project runs in your browser. The page, and what it logs, are in the preview.</p>
              <button type="button" onClick={() => usePreview.getState().run()} className="font-medium text-accent-ink hover:underline">
                Open the preview
              </button>
            </div>
          ) : (
            <RunToolWindow />
          ))}
        {tab === "debug" && <DebugToolWindow />}
        {tab === "visualize" && <VisualizerPanel />}
        {tab === "tests" && <TestsPanel />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "input" && <InputPanel />}
      </div>
    </section>
  );
}
