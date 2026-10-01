"use client";

import { toast } from "@/components/ui/toast";
import { editorBridge } from "@/features/editor/bridge";

type Report = (text: string) => void;

/** What lands on the system clipboard instead of the copied text. */
export const CLIPBOARD_NOTICE = "Copying is turned off during this interview.";

/**
 * The candidate's clipboard during an interview. Nothing copied on the page
 * reaches the system clipboard, and nothing from outside can be pasted in.
 * Copy, cut and paste still work on the candidate's own code: the text is kept
 * here, in the page, and pasted from here.
 */
let held: { text: string; wholeLine: boolean } | null = null;

type Field = HTMLTextAreaElement | HTMLInputElement;
const fieldOf = (el: Element | null): Field | null => (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && /^(text|search|)$/.test(el.type)) ? el : null);

/** Takes the selection of the code editor or of a text box (and removes it, for a cut). */
function take(cut: boolean): { text: string; wholeLine: boolean } | null {
  const ed = editorBridge.editor;
  const model = ed?.getModel();
  if (ed && model && ed.hasTextFocus()) {
    const selections = ed.getSelections() ?? [];
    const only = selections.length === 1 ? selections[0]! : null;
    if (only?.isEmpty()) {
      // No selection: the whole line, as in every code editor.
      const line = only.startLineNumber;
      const text = `${model.getLineContent(line)}\n`;
      const last = line === model.getLineCount();
      const range = last ? { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) } : { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 };
      if (cut) {
        ed.pushUndoStop();
        ed.executeEdits("cw.cut", [{ range, text: "" }]);
        ed.pushUndoStop();
      }
      return { text, wholeLine: true };
    }
    const text = selections.map((s) => model.getValueInRange(s)).join(model.getEOL());
    if (cut && text) {
      ed.pushUndoStop();
      ed.executeEdits("cw.cut", selections.map((range) => ({ range, text: "" })));
      ed.pushUndoStop();
    }
    return text ? { text, wholeLine: false } : null;
  }
  const field = fieldOf(document.activeElement);
  if (!field) return null; // The problem statement and everything else on the page is not copied at all.
  const text = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  if (cut && text && !field.readOnly) document.execCommand("delete");
  return text ? { text, wholeLine: false } : null;
}

/** Pastes the text held here into the code editor or the focused text box. */
function put() {
  if (!held) return;
  const ed = editorBridge.editor;
  if (ed?.hasTextFocus()) return ed.trigger("keyboard", "paste", { text: held.text, pasteOnNewLine: held.wholeLine, multicursorText: null, mode: null });
  const field = fieldOf(document.activeElement);
  if (field && !field.readOnly) document.execCommand("insertText", false, held.text);
}

/**
 * Locks the page down for the candidate while the interview runs: no copying
 * out, no pasting or dropping in, no right-click menu and no developer tools
 * shortcuts. `onPaste` is told about text someone tried to bring in.
 */
export function startLockdown(onPaste: Report): () => void {
  held = null;
  let lastToast = 0;
  const refused = (text: string) => {
    onPaste(text);
    if (Date.now() - lastToast < 4000) return;
    lastToast = Date.now();
    toast.error("Pasting is turned off", "Text from outside the interview cannot be pasted. The interviewer has been told.");
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onCopy = (e: ClipboardEvent) => {
    const taken = take(e.type === "cut");
    if (taken) held = taken;
    swallow(e);
    e.clipboardData?.setData("text/plain", CLIPBOARD_NOTICE);
  };
  const onPasteEvent = (e: ClipboardEvent) => {
    const outside = e.clipboardData?.getData("text/plain") ?? "";
    swallow(e);
    // Our own notice is on the clipboard: the last thing copied was copied here.
    if (outside === CLIPBOARD_NOTICE || (held && outside === held.text)) return put();
    if (outside) refused(outside);
  };
  const onDrop = (e: DragEvent) => {
    const text = e.dataTransfer?.getData("text/plain") ?? "";
    swallow(e);
    if (text) refused(text);
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

  // Code that reads the clipboard directly (the editor's Paste command) gets the held text too.
  const clipboard = navigator.clipboard as (Clipboard & Record<string, unknown>) | undefined;
  const patched = ["readText", "read", "writeText", "write"] as const;
  try {
    if (clipboard) {
      clipboard.readText = async () => held?.text ?? "";
      clipboard.read = async () => [];
      clipboard.writeText = async (text: string) => {
        held = { text, wholeLine: false };
      };
      clipboard.write = async () => {};
    }
  } catch {
    // A browser that does not allow this still has the paste event blocked.
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
    held = null;
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
