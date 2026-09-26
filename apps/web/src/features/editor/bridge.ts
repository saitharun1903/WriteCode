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

let instance: editor.IStandaloneCodeEditor | null = null;
let monacoInstance: Monaco | null = null;
/** `focus: false` scrolls to the line without moving the cursor or taking focus. */
let pendingReveal: { line: number; column: number; focus: boolean } | null = null;

export const editorBridge = {
  attach(ed: editor.IStandaloneCodeEditor, monaco: Monaco) {
    instance = ed;
    monacoInstance = monaco;
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
    instance.revealLineInCenterIfOutsideViewport(line);
    instance.focus();
  },
  /** Scrolls `line` into view without moving the cursor or taking focus. */
  showLine(line: number) {
    instance?.revealLineInCenterIfOutsideViewport(line);
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
  get monaco() {
    return monacoInstance;
  },
};
