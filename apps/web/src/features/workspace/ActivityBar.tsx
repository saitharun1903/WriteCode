"use client";

import { Files, History, Search, Settings } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { primaryShortcut } from "@/features/commands/registry";
import { useSettings, type SideView } from "@/features/settings/store";
import { useUI } from "./ui-store";

const VIEWS: { id: SideView; label: string; icon: React.ReactNode; command: string }[] = [
  { id: "explorer", label: "Explorer", icon: <Files />, command: "view.explorer" },
  { id: "search", label: "Search", icon: <Search />, command: "view.search" },
  { id: "history", label: "History", icon: <History />, command: "view.history" },
];

export function ActivityBar() {
  const layout = useSettings((s) => s.layout);
  const updateLayout = useSettings((s) => s.updateLayout);

  return (
    <nav aria-label="Views" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-canvas py-2">
      {VIEWS.map((v) => {
        const active = layout.sidebarOpen && layout.sideView === v.id;
        return (
          <div key={v.id} className="relative">
            {active && <span className="absolute -left-2 top-1.5 h-4 w-0.5 rounded-r bg-accent" />}
            <IconButton
              label={v.label}
              shortcut={primaryShortcut(v.command)}
              tooltipSide="right"
              active={active}
              className="size-8"
              onClick={() => updateLayout(active ? { sidebarOpen: false } : { sidebarOpen: true, sideView: v.id })}
            >
              {v.icon}
            </IconButton>
          </div>
        );
      })}
      <div className="mt-auto">
        <IconButton label="Settings" shortcut="Mod+," tooltipSide="right" className="size-8" onClick={() => useUI.getState().setSettingsOpen(true)}>
          <Settings />
        </IconButton>
      </div>
    </nav>
  );
}
