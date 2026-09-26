"use client";

import { loader, type Monaco } from "@monaco-editor/react";

// Monaco is copied into /public by scripts/copy-monaco.mjs, so the editor
// never depends on a third-party CDN.
loader.config({ paths: { vs: "/monaco/vs" } });

let themesDefined = false;

/** Editor themes derived from the design tokens in globals.css. */
export function defineThemes(monaco: Monaco) {
  if (themesDefined) return;
  themesDefined = true;

  monaco.editor.defineTheme("cw-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "5f6773", fontStyle: "italic" },
      { token: "keyword", foreground: "c792ea" },
      { token: "string", foreground: "a5d6a7" },
      { token: "number", foreground: "f5b971" },
      { token: "type", foreground: "7fd4e8" },
      { token: "type.identifier", foreground: "7fd4e8" },
      { token: "annotation", foreground: "e8b85c" },
      { token: "delimiter", foreground: "8c939e" },
    ],
    colors: {
      "editor.background": "#0f1113",
      "editor.foreground": "#e2e5e9",
      "editorLineNumber.foreground": "#3b4149",
      "editorLineNumber.activeForeground": "#9aa1ab",
      "editor.lineHighlightBackground": "#15181b",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#6ee7c833",
      "editor.inactiveSelectionBackground": "#6ee7c81a",
      "editorCursor.foreground": "#6ee7c8",
      "editorIndentGuide.background1": "#1c2025",
      "editorIndentGuide.activeBackground1": "#2e343b",
      "editorWhitespace.foreground": "#2a2f35",
      "editorGutter.background": "#0f1113",
      "editorWidget.background": "#1c1f24",
      "editorWidget.border": "#2b3037",
      "editorSuggestWidget.background": "#1c1f24",
      "editorSuggestWidget.border": "#2b3037",
      "editorSuggestWidget.selectedBackground": "#262a30",
      "editorHoverWidget.background": "#1c1f24",
      "editorHoverWidget.border": "#2b3037",
      "input.background": "#141619",
      "input.border": "#2b3037",
      "focusBorder": "#6ee7c880",
      "scrollbarSlider.background": "#ffffff12",
      "scrollbarSlider.hoverBackground": "#ffffff1f",
      "scrollbarSlider.activeBackground": "#ffffff2a",
      "minimap.background": "#0f1113",
      "editorBracketMatch.background": "#6ee7c81f",
      "editorBracketMatch.border": "#6ee7c866",
      "editorError.foreground": "#f2767b",
      "editorWarning.foreground": "#e8b85c",
      "editorInfo.foreground": "#7aa7ff",
      "editorOverviewRuler.border": "#00000000",
    },
  });

  monaco.editor.defineTheme("cw-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8a919b", fontStyle: "italic" },
      { token: "keyword", foreground: "8e3fbf" },
      { token: "string", foreground: "2f7d32" },
      { token: "number", foreground: "b25c00" },
      { token: "type", foreground: "0b7a99" },
      { token: "type.identifier", foreground: "0b7a99" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#16181c",
      "editorLineNumber.foreground": "#b8bdc4",
      "editorLineNumber.activeForeground": "#555c66",
      "editor.lineHighlightBackground": "#f5f7f9",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#0f9b7a2e",
      "editorCursor.foreground": "#0f9b7a",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#cfd4da",
      "focusBorder": "#0f9b7a80",
      "minimap.background": "#ffffff",
      "editorOverviewRuler.border": "#00000000",
    },
  });
}

/** Monaco model URI for a project file. Keeping one model per file preserves undo history across tabs. */
export function modelUri(monaco: Monaco, projectId: string, path: string) {
  return monaco.Uri.parse(`file:///${projectId}/${path}`);
}
