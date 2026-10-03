"use client";

import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { create } from "zustand";

/**
 * Narrow bridge between the React tree and the live Monaco instance, so
 * panels (Problems, Search, History) can reveal locations and trigger editor
 * actions without holding editor refs themselves.
 */

interface CursorState {
  line: number;
  column: number;
}

export const useCursor = create<CursorState>(() => ({ line: 1, column: 1 }));

/** TypeScript diagnostics about the editor not knowing a package, not about the program: Node finds those. */
export const UNKNOWN_PACKAGE_CODES = new Set([2307, 2580, 2591, 2592, 2792, 7016]);

/** Pixels at the bottom of the editor hidden under a panel (a sheet on a phone); the editor leaves that much room after its last line. */
export const useCoveredBelow = create<{ px: number }>(() => ({ px: 0 }));

let instance: editor.IStandaloneCodeEditor | null = null;
let monacoInstance: Monaco | null = null;
/** `focus: false` scrolls to the line without moving the cursor or taking focus. */
let pendingReveal: { line: number; column: number; focus: boolean } | null = null;
const attachListeners = new Set<(ed: editor.IStandaloneCodeEditor, monaco: Monaco) => void>();

/** Pixels at the bottom of the editor hidden under a panel, and the line last scrolled to. */
let coveredBelow = 0;
let lastShown: number | null = null;

/** Brings `line` into the part of the editor that can be seen, centred there when it was out of it. */
function scrollToLine(line: number) {
  if (!instance) return;
  lastShown = line;
  if (!coveredBelow || !monacoInstance) {
    instance.revealLineInCenterIfOutsideViewport(line);
    return;
  }
  const lineHeight = instance.getOption(monacoInstance.editor.EditorOption.lineHeight);
  // A line of room above the panel's edge, so the line is not half under it.
  const height = Math.max(instance.getLayoutInfo().height - coveredBelow - lineHeight, lineHeight);
  const top = instance.getTopForLineNumber(line);
  const scrolled = instance.getScrollTop();
  if (top >= scrolled && top + lineHeight <= scrolled + height) return;
  instance.setScrollTop(Math.max(0, top - (height - lineHeight) / 2));
}

export const editorBridge = {
  attach(ed: editor.IStandaloneCodeEditor, monaco: Monaco) {
    instance = ed;
    monacoInstance = monaco;
    for (const fn of attachListeners) fn(ed, monaco);
    ed.onDidChangeModel(() => {
      if (!pendingReveal) return;
      const { line, column, focus } = pendingReveal;
      pendingReveal = null;
      // Defer one frame so the new model's view is laid out before revealing.
      requestAnimationFrame(() => (focus ? editorBridge.reveal(line, column) : editorBridge.showLine(line)));
    });
  },
  detach() {
    instance = null;
    monacoInstance = null;
  },
  setCursor(line: number, column: number) {
    useCursor.setState({ line, column });
  },
  /** Moves the cursor to a location in the current model and focuses the editor. */
  reveal(line: number, column = 1) {
    if (!instance) return;
    instance.setPosition({ lineNumber: line, column });
    scrollToLine(line);
    instance.focus();
  },
  /** Scrolls `line` into view without moving the cursor or taking focus. */
  showLine(line: number) {
    scrollToLine(line);
  },
  /**
   * How much of the editor's bottom a panel covers (a sheet on a phone), in
   * pixels: lines are then shown in the part above it. The last line shown is
   * brought into that part straight away.
   */
  setCoveredBelow(px: number) {
    if (px === coveredBelow) return;
    coveredBelow = px;
    useCoveredBelow.setState({ px: Math.round(px) });
    if (px > 0 && lastShown) {
      const line = lastShown;
      // After the editor has taken its new padding.
      setTimeout(() => scrollToLine(line), 50);
    }
  },
  /** Reveal after the next model switch (used when navigating to another file). */
  revealAfterSwitch(line: number, column = 1, focus = true) {
    pendingReveal = { line, column, focus };
  },
  trigger(actionId: string) {
    if (!instance) return false;
    instance.focus();
    const action = instance.getAction(actionId);
    if (action) void action.run();
    else instance.trigger("keyboard", actionId, null);
    return true;
  },
  focus() {
    instance?.focus();
  },
  /** The editor's selected text and its 1-based line range, or null when nothing is selected. */
  selection(): { startLine: number; endLine: number; text: string } | null {
    const model = instance?.getModel();
    const sel = instance?.getSelection();
    if (!model || !sel || sel.isEmpty()) return null;
    return { startLine: sel.startLineNumber, endLine: sel.endLineNumber, text: model.getValueInRange(sel) };
  },
  /**
   * The TypeScript checker's errors in a project's files (not the ones about a
   * package the editor does not know: Node finds those). Node runs TypeScript
   * without checking types, so these are shown beside the run's output.
   */
  typeErrors(projectId: string, ignore: Set<number>): { file: string; line: number; message: string }[] {
    const monaco = monacoInstance;
    if (!monaco) return [];
    const out: { file: string; line: number; message: string }[] = [];
    for (const m of monaco.editor.getModelMarkers({ owner: "typescript" })) {
      const parts = m.resource.path.split("/");
      if (parts[1] !== projectId || m.severity !== monaco.MarkerSeverity.Error) continue;
      const code = Number(typeof m.code === "object" ? m.code?.value : m.code);
      if (ignore.has(code)) continue;
      out.push({ file: decodeURIComponent(parts.slice(2).join("/")), line: m.startLineNumber, message: m.message.split("\n")[0]! });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  },
  /** Path (within its project) of the file shown in the editor, or null. */
  currentPath(): string | null {
    const path = instance?.getModel()?.uri.path;
    return path ? decodeURIComponent(path.split("/").slice(2).join("/")) : null;
  },
  /**
   * Replaces the open file's text with `next`, changing only the lines that
   * differ, as one undoable edit (Ctrl+Z reverts it). The changed lines are
   * revealed and briefly highlighted. Returns false when no file is open.
   */
  applyContent(next: string): boolean {
    const model = instance?.getModel();
    const monaco = monacoInstance;
    if (!instance || !model || !monaco) return false;
    const a = model.getLinesContent();
    const b = next.split(/\r?\n/);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    if (p === a.length && p === b.length) return true;
    const eol = model.getEOL();
    const slice = b.slice(p, b.length - s);
    const endExclusive = a.length - s;
    let range;
    let text;
    if (endExclusive < a.length) {
      // Replace whole lines up to the start of the first unchanged line after them.
      range = new monaco.Range(p + 1, 1, endExclusive + 1, 1);
      text = slice.map((l) => l + eol).join("");
    } else if (p > 0) {
      // The change runs to the end of the file: anchor on the end of the line before it.
      range = new monaco.Range(p, model.getLineMaxColumn(p), a.length, model.getLineMaxColumn(a.length));
      text = slice.map((l) => eol + l).join("");
    } else {
      range = model.getFullModelRange();
      text = slice.join(eol);
    }
    instance.pushUndoStop();
    instance.executeEdits("assistant", [{ range, text, forceMoveMarkers: true }]);
    instance.pushUndoStop();
    if (slice.length > 0) {
      const first = p + 1;
      const last = p + slice.length;
      instance.revealLinesInCenterIfOutsideViewport(first, last);
      const flash = instance.createDecorationsCollection([
        { range: new monaco.Range(first, 1, last, 1), options: { isWholeLine: true, className: "cw-ai-applied", linesDecorationsClassName: "cw-ai-applied-gutter" } },
      ]);
      setTimeout(() => flash.clear(), 2600);
    }
    return true;
  },
  /** Replaces the selection (or inserts at the cursor) as one undoable edit. */
  insert(text: string): boolean {
    const sel = instance?.getSelection();
    if (!instance || !sel) return false;
    instance.pushUndoStop();
    instance.executeEdits("assistant", [{ range: sel, text, forceMoveMarkers: true }]);
    instance.pushUndoStop();
    instance.focus();
    return true;
  },
  get monaco() {
    return monacoInstance;
  },
  get editor() {
    return instance;
  },
  /** Calls `fn` with the editor now (if mounted) and whenever a new one mounts. */
  onAttach(fn: (ed: editor.IStandaloneCodeEditor, monaco: Monaco) => void): () => void {
    attachListeners.add(fn);
    if (instance && monacoInstance) fn(instance, monacoInstance);
    return () => attachListeners.delete(fn);
  },
};
