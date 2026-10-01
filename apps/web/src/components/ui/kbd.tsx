"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { formatShortcut, isMac } from "@/lib/platform";
import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";

const subscribe = () => () => {};

/**
 * Renders a shortcut the way desktop IDEs do: plain secondary text,
 * "Ctrl+Shift+P" on Windows/Linux and "⇧⌘P" on macOS.
 */
export function Kbd({ shortcut, className }: { shortcut: string; className?: string }) {
  // Phones and touch tablets have no keyboard to press it on.
  const touch = useMediaQuery(COMPACT_QUERY);
  // Platform is only known on the client; render the Windows form during SSR.
  const text = useSyncExternalStore(
    subscribe,
    () => formatShortcut(shortcut).join(isMac() ? "" : "+"),
    () => shortcut.replaceAll("Mod", "Ctrl"),
  );
  if (touch) return null;
  return <kbd className={cn("whitespace-nowrap font-sans text-xs text-fg-subtle", className)}>{text}</kbd>;
}
