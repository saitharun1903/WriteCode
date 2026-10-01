"use client";

import { toast } from "@/components/ui/toast";

type Report = (text: string) => void;

/**
 * Locks the page down for the candidate while the interview runs: nothing can
 * be copied or cut (not the problem, not the code), nothing can be pasted or
 * dropped in, and there is no right-click menu and no developer tools
 * shortcuts. The code is typed. `onPaste` is told about text someone tried to
 * bring in.
 */
export function startLockdown(onPaste: Report): () => void {
  let lastToast = 0;
  const say = (title: string, detail: string) => {
    if (Date.now() - lastToast < 4000) return;
    lastToast = Date.now();
    toast.error(title, detail);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onCopy = (e: ClipboardEvent) => {
    swallow(e);
    say("Copying is turned off", "During the interview nothing can be copied or cut.");
  };
  const onPasteEvent = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") ?? "";
    swallow(e);
    if (text) onPaste(text);
    say("Pasting is turned off", "Type your code. The interviewer has been told about the paste.");
  };
  const onDrop = (e: DragEvent) => {
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    swallow(e);
    if (text) {
      onPaste(text);
      say("Pasting is turned off", "Type your code. The interviewer has been told about the paste.");
    }
  };
  const onDragOver = (e: DragEvent) => {
    swallow(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Developer tools, view source, print, save and open: none of them belong in an interview.
    if (e.key === "F12" || (mod && e.shiftKey && ["i", "j", "c"].includes(key)) || (mod && !e.shiftKey && ["u", "p", "s", "o"].includes(key))) swallow(e);
  };
  // A paste that arrives without a paste event (some on-screen keyboards, drag and drop into a text box).
  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop" || e.inputType === "insertFromYank") swallow(e);
  };
  // Closing or reloading the tab by accident would leave the interview.
  const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();

  // Code that uses the clipboard directly (the editor's own Copy and Paste commands) gets nothing.
  const clipboard = navigator.clipboard as (Clipboard & Record<string, unknown>) | undefined;
  const patched = ["readText", "read", "writeText", "write"] as const;
  try {
    if (clipboard) {
      clipboard.readText = async () => "";
      clipboard.read = async () => [];
      clipboard.writeText = async () => {};
      clipboard.write = async () => {};
    }
  } catch {
    // A browser that does not allow this still has the clipboard events blocked.
  }

  const capture = { capture: true } as const;
  document.addEventListener("copy", onCopy, capture);
  document.addEventListener("cut", onCopy, capture);
  document.addEventListener("paste", onPasteEvent, capture);
  document.addEventListener("drop", onDrop, capture);
  document.addEventListener("dragover", onDragOver, capture);
  document.addEventListener("contextmenu", swallow, capture);
  document.addEventListener("beforeinput", onBeforeInput, capture);
  window.addEventListener("keydown", onKeyDown, capture);
  window.addEventListener("beforeunload", onBeforeUnload);
  document.documentElement.dataset.lockdown = "on";
  return () => {
    document.removeEventListener("copy", onCopy, capture);
    document.removeEventListener("cut", onCopy, capture);
    document.removeEventListener("paste", onPasteEvent, capture);
    document.removeEventListener("drop", onDrop, capture);
    document.removeEventListener("dragover", onDragOver, capture);
    document.removeEventListener("contextmenu", swallow, capture);
    document.removeEventListener("beforeinput", onBeforeInput, capture);
    window.removeEventListener("keydown", onKeyDown, capture);
    window.removeEventListener("beforeunload", onBeforeUnload);
    delete document.documentElement.dataset.lockdown;
    try {
      if (clipboard) for (const name of patched) delete clipboard[name];
    } catch {}
  };
}

type KeyboardLock = { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };

/**
 * In full screen, Chrome and Edge let a page keep the keys that switch windows
 * (Alt+Tab, the Windows key, Escape). Other browsers have no such lock; there,
 * leaving is seen and counted instead.
 */
export function lockKeyboard() {
  void (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard?.lock?.().catch(() => {});
}

export function unlockKeyboard() {
  try {
    (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard?.unlock?.();
  } catch {}
}
