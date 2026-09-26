/** True on macOS/iOS, where the primary modifier is ⌘ instead of Ctrl. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Formats a shortcut like "Mod+Shift+P" for display on the current platform. */
export function formatShortcut(shortcut: string): string[] {
  const mac = isMac();
  return shortcut.split("+").map((part) => {
    switch (part) {
      case "Mod":
        return mac ? "⌘" : "Ctrl";
      case "Shift":
        return mac ? "⇧" : "Shift";
      case "Alt":
        return mac ? "⌥" : "Alt";
      case "Enter":
        return mac ? "↩" : "Enter";
      default:
        return part;
    }
  });
}
