"use client";

import { Bug, CircleAlert, FolderClosed, History, Keyboard, Play, Search, Workflow } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { primaryShortcut } from "@/features/commands/registry";
import { useExecution } from "@/features/execution/store";
import { useSettings, type BottomTab, type SideView } from "@/features/settings/store";
import { cn } from "@/lib/cn";

const SIDE: { id: SideView; label: string; icon: React.ReactNode; command: string }[] = [
  { id: "explorer", label: "Project", icon: <FolderClosed />, command: "view.explorer" },
  { id: "search", label: "Find in Files", icon: <Search />, command: "view.search" },
  { id: "history", label: "History", icon: <History />, command: "view.history" },
];

const BOTTOM: { id: BottomTab; label: string; icon: React.ReactNode; command: string }[] = [
  { id: "run", label: "Run", icon: <Play />, command: "view.run" },
  { id: "debug", label: "Debug", icon: <Bug />, command: "view.debug" },
  { id: "visualize", label: "Visualize", icon: <Workflow />, command: "view.visualize" },
  { id: "problems", label: "Problems", icon: <CircleAlert />, command: "view.problems" },
  { id: "input", label: "Program Input", icon: <Keyboard />, command: "view.input" },
];

/** Tool window stripe: side tool windows at the top, bottom tool windows below. */
export function ActivityBar() {
  const layout = useSettings((s) => s.layout);
  const updateLayout = useSettings((s) => s.updateLayout);
  const errorCount = useExecution((s) => s.diagnostics.filter((d) => d.severity === "error").length);

  const stripeButton = (active: boolean, label: string, command: string, icon: React.ReactNode, onClick: () => void, badge?: boolean) => (
    <div key={label} className="relative">
      <IconButton
        label={label}
        shortcut={primaryShortcut(command)}
        tooltipSide="right"
        active={active}
        className={cn("size-8 [&_svg]:size-[18px]", !active && "text-fg-muted")}
        onClick={onClick}
      >
        {icon}
      </IconButton>
      {badge && <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-danger" />}
    </div>
  );

  return (
    <nav aria-label="Tool windows" className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-line bg-canvas py-1.5">
      {SIDE.map((v) => {
        const active = layout.sidebarOpen && layout.sideView === v.id;
        return stripeButton(active, v.label, v.command, v.icon, () =>
          updateLayout(active ? { sidebarOpen: false } : { sidebarOpen: true, sideView: v.id }),
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-1">
        {BOTTOM.map((v) => {
          const active = layout.bottomOpen && layout.bottomTab === v.id;
          return stripeButton(
            active,
            v.label,
            v.command,
            v.icon,
            () => updateLayout(active ? { bottomOpen: false } : { bottomOpen: true, bottomTab: v.id }),
            v.id === "problems" && errorCount > 0,
          );
        })}
      </div>
    </nav>
  );
}
