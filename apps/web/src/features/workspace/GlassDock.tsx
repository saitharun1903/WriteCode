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
  /** The AI tab glows in its own colour. */
  tone?: "ai";
  onSelect: () => void;
}

const DOT: Record<NonNullable<DockItem["dot"]>, string> = {
  run: "bg-success",
  pause: "bg-warning",
  record: "bg-accent",
};

/** Springy, but settles quickly: the capsule glides to the tab that was tapped. */
const GLIDE = { type: "spring", stiffness: 520, damping: 38, mass: 0.9 } as const;

/**
 * Phone and tablet navigation: a floating glass pill. The active tab sits in a
 * glossy capsule that glides between tabs; a sheen sweeps across it when it
 * lands. Only transforms and opacity animate, so it stays smooth on phones.
 */
export function GlassDock({ items }: { items: DockItem[] }) {
  const reduce = useReducedMotion();
  const activeId = items.find((i) => i.active)?.id ?? null;
  return (
    <nav aria-label="Panels" className="cw-dock pointer-events-auto flex h-[58px] items-stretch gap-0.5 rounded-full p-[5px]">
      {items.map((item) => (
        <motion.button
          key={item.id}
          type="button"
          aria-label={item.label}
          aria-pressed={item.active}
          whileTap={reduce ? undefined : { scale: 0.88 }}
          transition={{ type: "spring", stiffness: 700, damping: 30 }}
          onClick={() => {
            // A light tick where the phone supports it (Android).
            if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(6);
            item.onSelect();
          }}
          className={cn(
            // Icons only: each tab's name is its accessible label.
            "relative flex min-w-0 flex-1 items-center justify-center rounded-full outline-none sm:min-w-16",
            "[-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-accent/70",
            item.active ? (item.tone === "ai" ? "cw-dock-fg-ai" : "cw-dock-fg-active") : "cw-dock-fg",
          )}
        >
          {item.active && (
            <motion.span layoutId="cw-dock-capsule" transition={reduce ? { duration: 0 } : GLIDE} aria-hidden className={cn("cw-dock-capsule absolute inset-0 rounded-full", item.tone === "ai" && "cw-dock-capsule-ai")}>
              {/* The sheen replays each time the capsule lands on a new tab. */}
              {!reduce && <span key={activeId} className="cw-dock-sheen" />}
            </motion.span>
          )}
          <motion.span
            aria-hidden
            animate={reduce ? undefined : { y: item.active ? -1 : 0, scale: item.active ? 1.08 : 1 }}
            transition={GLIDE}
            className="relative z-10 flex [&_svg]:size-[21px] [&_svg]:stroke-[1.9] sm:[&_svg]:size-[22px]"
          >
            {item.icon}
            {item.dot && <span className={cn("absolute -right-1 -top-0.5 size-[7px] rounded-full ring-2 ring-[var(--dock-ring)]", DOT[item.dot], item.dot !== "pause" && "animate-pulse")} />}
          </motion.span>
        </motion.button>
      ))}
    </nav>
  );
}
