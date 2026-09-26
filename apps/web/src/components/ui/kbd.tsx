"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { formatShortcut } from "@/lib/platform";

const subscribe = () => () => {};

/** Renders a shortcut like "Mod+Enter" using the viewer's platform symbols. */
export function Kbd({ shortcut, className }: { shortcut: string; className?: string }) {
  // Platform is only known on the client; render the generic form during SSR.
  const keys = useSyncExternalStore(
    subscribe,
    () => formatShortcut(shortcut).join("\u0000"),
    () => shortcut.replaceAll("Mod", "Ctrl").split("+").join("\u0000"),
  ).split("\u0000");

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((k, i) => (
        <kbd
          key={i}
          className="min-w-4 rounded-[3px] border border-line bg-surface-3 px-1 text-center font-sans text-2xs text-fg-subtle"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}
