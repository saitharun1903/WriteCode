"use client";

import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/cn";

export interface DockItem {
  id: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  /** A live state on the tab: the program running, paused, recording. */
  dot?: "run" | "pause" | "record";
  onSelect: () => void;
}

const DOT: Record<NonNullable<DockItem["dot"]>, string> = {
  run: "bg-success",
  pause: "bg-warning",
  record: "bg-danger",
};

/** Quick, with no bounce: the mark moves to the tab that was tapped. */
const GLIDE = { type: "spring", stiffness: 560, damping: 44, mass: 0.8 } as const;

/**
 * Phone and tablet navigation, where a thumb expects it: a tab bar along the
 * bottom of a phone, a rail down the left of a tablet. Icons only (each tab's
 * name is its accessible label); the open tab sits on a soft amber mark.
 */
export function PanelTabs({ items, rail = false }: { items: DockItem[]; rail?: boolean }) {
  const reduce = useReducedMotion();
  return (
    <nav
      aria-label="Panels"
      className={cn(
        "flex shrink-0 select-none bg-canvas",
        rail ? "w-16 flex-col items-center gap-1 border-r border-line py-2" : "items-stretch border-t border-line px-1 pb-[env(safe-area-inset-bottom)]",
      )}
    >
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          aria-label={item.label}
          aria-pressed={item.active}
          onClick={() => {
            // A light tick where the phone supports it (Android).
            if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(6);
            item.onSelect();
          }}
          className={cn(
            "group relative flex items-center justify-center outline-none [-webkit-tap-highlight-color:transparent]",
            // On the rail, the last tab (the assistant) sits at the foot.
            rail ? cn("h-[52px] w-full", i === items.length - 1 && items.length > 2 && "mt-auto") : "h-14 min-w-0 flex-1",
          )}
        >
          <span
            className={cn(
              "relative flex items-center justify-center transition-colors duration-150 group-active:scale-95 group-focus-visible:ring-2 group-focus-visible:ring-accent-line",
              rail ? "size-11 rounded-[14px]" : "h-9 w-[52px] max-w-full rounded-full",
              item.active ? "text-accent-ink" : "text-fg-subtle",
            )}
          >
            {item.active && <motion.span layoutId="cw-tab-mark" transition={reduce ? { duration: 0 } : GLIDE} aria-hidden className="absolute inset-0 rounded-[inherit] bg-accent-soft" />}
            <span aria-hidden className={cn("relative flex [&_svg]:size-[22px]", item.active ? "[&_svg]:stroke-[2.1]" : "[&_svg]:stroke-[1.8]")}>
              {item.icon}
              {item.dot && <span className={cn("absolute -right-1 -top-0.5 size-2 rounded-full ring-2 ring-canvas", DOT[item.dot], item.dot !== "pause" && "animate-pulse")} />}
            </span>
          </span>
        </button>
      ))}
    </nav>
  );
}
