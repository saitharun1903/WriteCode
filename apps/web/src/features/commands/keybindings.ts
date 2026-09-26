"use client";

import { useEffect } from "react";
import { isMac } from "@/lib/platform";
import { COMMANDS, isEnabled } from "./registry";

const CODE_TO_KEY: Record<string, string> = {
  Enter: "Enter",
  Equal: "=",
  Minus: "-",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Escape: "Escape",
};

/** Normalizes a keyboard event to the registry's shortcut format, e.g. "Mod+Shift+P". */
export function eventToShortcut(e: KeyboardEvent, mac = isMac()): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_TO_KEY[e.code];
  if (!key) return null;

  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

function buildBindings(): Map<string, string> {
  const map = new Map<string, string>();
  for (const cmd of COMMANDS) {
    if (!cmd.shortcut) continue;
    for (const binding of cmd.shortcut.split(" / ")) {
      // Canonical modifier order: Mod, Shift, Alt.
      const parts = binding.split("+");
      const key = parts.pop()!;
      const order = ["Mod", "Shift", "Alt"].filter((m) => parts.includes(m));
      map.set([...order, key].join("+"), cmd.id);
    }
  }
  return map;
}

/** Installs global shortcuts. Monaco handles its own when focused and marks those events defaultPrevented. */
export function useGlobalKeybindings() {
  useEffect(() => {
    const bindings = buildBindings();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const shortcut = eventToShortcut(e);
      if (!shortcut) return;
      const id = bindings.get(shortcut);
      if (!id) return;
      const cmd = COMMANDS.find((c) => c.id === id)!;
      e.preventDefault();
      if (isEnabled(cmd)) cmd.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
