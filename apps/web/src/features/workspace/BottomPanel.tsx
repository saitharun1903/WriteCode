"use client";

import { ChevronDown, X } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { InputPanel } from "@/features/execution/InputPanel";
import { OutputPanel } from "@/features/execution/OutputPanel";
import { ProblemsPanel } from "@/features/execution/ProblemsPanel";
import { useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings, type BottomTab } from "@/features/settings/store";
import { cn } from "@/lib/cn";

export function BottomPanel({ onClose }: { onClose: () => void }) {
  const tab = useSettings((s) => s.layout.bottomTab);
  const updateLayout = useSettings((s) => s.updateLayout);
  const problemCount = useExecution((s) => s.diagnostics.length);
  const hasStdin = useWorkspace((s) => !!s.project?.stdin);

  const tabs: { id: BottomTab; label: string; badge?: React.ReactNode }[] = [
    { id: "output", label: "Output" },
    {
      id: "problems",
      label: "Problems",
      badge: problemCount > 0 && <span className="rounded-sm bg-danger-soft px-1 text-2xs text-danger">{problemCount}</span>,
    },
    { id: "input", label: "Input", badge: hasStdin && <span className="size-1.5 rounded-full bg-accent" aria-label="has input" /> },
  ];

  return (
    <section aria-label="Panel" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center border-b border-line pl-1 pr-1">
        <div role="tablist" className="flex h-full items-stretch">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => updateLayout({ bottomTab: t.id })}
              className={cn(
                "relative flex items-center gap-1.5 px-2.5 text-xs font-medium uppercase tracking-[0.06em]",
                tab === t.id ? "text-fg" : "text-fg-subtle hover:text-fg-muted",
              )}
            >
              {t.label}
              {t.badge}
              {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-px bg-accent" />}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center">
          <IconButton label="Hide panel" shortcut="Mod+J" size="sm" onClick={onClose}>
            <span className="hidden sm:inline"><X /></span>
            <span className="sm:hidden"><ChevronDown /></span>
          </IconButton>
        </div>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {tab === "output" && <OutputPanel />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "input" && <InputPanel />}
      </div>
    </section>
  );
}
