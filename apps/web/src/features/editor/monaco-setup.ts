"use client";

import { loader, type Monaco } from "@monaco-editor/react";
import { NODE_TYPES } from "./node-types";

// Monaco is copied into /public by scripts/copy-monaco.mjs, so the editor
// never depends on a third-party CDN.
loader.config({ paths: { vs: `/monaco/${process.env.NEXT_PUBLIC_MONACO_VERSION}/vs` } });

/** Starts downloading the editor in the background, so it is ready when a project opens. */
export function preloadMonaco() {
  void loader.init().catch(() => {});
}

let themesDefined = false;

/**
 * Editor colour schemes modelled on the JetBrains New UI "Dark" and "Light"
 * schemes in light; the dark scheme is a night blue with violet keywords, green
 * strings, orange numbers and blue types, to match the interface around it.
 */
export function defineThemes(monaco: Monaco) {
  if (themesDefined) return;
  themesDefined = true;
  configureTypeScript(monaco);

  monaco.editor.defineTheme("cw-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "d5d9e6" },
      { token: "comment", foreground: "66708c", fontStyle: "italic" },
      { token: "comment.doc", foreground: "6f9a84", fontStyle: "italic" },
      { token: "keyword", foreground: "c296ff" },
      { token: "string", foreground: "8fd694" },
      { token: "string.escape", foreground: "ffb86b" },
      { token: "number", foreground: "ffa26b" },
      { token: "type", foreground: "7cc4ff" },
      { token: "type.identifier", foreground: "7cc4ff" },
      { token: "identifier", foreground: "d5d9e6" },
      { token: "annotation", foreground: "f0cf7a" },
      { token: "delimiter", foreground: "a7aec4" },
      { token: "delimiter.curly", foreground: "a7aec4" },
      { token: "delimiter.parenthesis", foreground: "a7aec4" },
      { token: "delimiter.square", foreground: "a7aec4" },
      { token: "delimiter.bracket", foreground: "a7aec4" },
      { token: "delimiter.angle", foreground: "a7aec4" },
      { token: "operator", foreground: "8fd3ff" },
      { token: "regexp", foreground: "5fd7e6" },
      { token: "tag", foreground: "f0cf7a" },
    ],
    colors: {
      "editor.background": "#0b0d13",
      "editor.foreground": "#d5d9e6",
      "editorBracketHighlight.foreground1": "#a7aec4",
      "editorBracketHighlight.foreground2": "#a7aec4",
      "editorBracketHighlight.foreground3": "#a7aec4",
      "editorBracketHighlight.foreground4": "#a7aec4",
      "editorBracketHighlight.foreground5": "#a7aec4",
      "editorBracketHighlight.foreground6": "#a7aec4",
      "editorBracketHighlight.unexpectedBracket.foreground": "#a7aec4",
      "editorLineNumber.foreground": "#3f465c",
      "editorLineNumber.activeForeground": "#a9b0c7",
      "editor.lineHighlightBackground": "#141825",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#25408c",
      "editor.inactiveSelectionBackground": "#1f2f5c",
      "editor.selectionHighlightBackground": "#2a3350",
      "editor.wordHighlightBackground": "#2a3350",
      "editor.findMatchBackground": "#2f6a45",
      "editor.findMatchHighlightBackground": "#234a35",
      "editorCursor.foreground": "#8fb0ff",
      "editorIndentGuide.background1": "#1b2030",
      "editorIndentGuide.activeBackground1": "#3a425a",
      "editorWhitespace.foreground": "#2a3044",
      "editorGutter.background": "#0b0d13",
      "editorWidget.background": "#181c29",
      "editorWidget.border": "#2d3347",
      "editorSuggestWidget.background": "#181c29",
      "editorSuggestWidget.border": "#2d3347",
      "editorSuggestWidget.selectedBackground": "#1e2c57",
      "editorHoverWidget.background": "#181c29",
      "editorHoverWidget.border": "#2d3347",
      "input.background": "#0b0d13",
      "input.border": "#2d3347",
      "focusBorder": "#4b7bff",
      "list.hoverBackground": "#1f2434",
      "list.activeSelectionBackground": "#1e2c57",
      "scrollbarSlider.background": "#ffffff12",
      "scrollbarSlider.hoverBackground": "#ffffff22",
      "scrollbarSlider.activeBackground": "#ffffff2e",
      "minimap.background": "#0b0d13",
      "editorBracketMatch.background": "#2d3550",
      "editorBracketMatch.border": "#00000000",
      "editorError.foreground": "#f2626f",
      "editorWarning.foreground": "#f4c761",
      "editorInfo.foreground": "#6d9dff",
      "editorOverviewRuler.border": "#00000000",
      "editorStickyScroll.background": "#0b0d13",
      "editorStickyScrollHover.background": "#141825",
    },
  });

  monaco.editor.defineTheme("cw-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "", foreground: "080808" },
      { token: "comment", foreground: "8c8c8c", fontStyle: "italic" },
      { token: "keyword", foreground: "0033b3" },
      { token: "string", foreground: "067d17" },
      { token: "string.escape", foreground: "0037a6" },
      { token: "number", foreground: "1750eb" },
      { token: "type", foreground: "000000" },
      { token: "type.identifier", foreground: "000000" },
      { token: "identifier", foreground: "080808" },
      { token: "annotation", foreground: "9e880d" },
      { token: "delimiter", foreground: "080808" },
      { token: "delimiter.curly", foreground: "080808" },
      { token: "delimiter.parenthesis", foreground: "080808" },
      { token: "delimiter.square", foreground: "080808" },
      { token: "delimiter.bracket", foreground: "080808" },
      { token: "delimiter.angle", foreground: "080808" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#080808",
      "editorBracketHighlight.foreground1": "#080808",
      "editorBracketHighlight.foreground2": "#080808",
      "editorBracketHighlight.foreground3": "#080808",
      "editorBracketHighlight.foreground4": "#080808",
      "editorBracketHighlight.foreground5": "#080808",
      "editorBracketHighlight.foreground6": "#080808",
      "editorBracketHighlight.unexpectedBracket.foreground": "#080808",
      "editorLineNumber.foreground": "#aeb3c2",
      "editorLineNumber.activeForeground": "#767a8a",
      "editor.lineHighlightBackground": "#f5f8fe",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#a6d2ff",
      "editor.inactiveSelectionBackground": "#d5e4fb",
      "editorCursor.foreground": "#000000",
      "editorIndentGuide.background1": "#ebecf0",
      "editorIndentGuide.activeBackground1": "#c9ccd6",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editorWidget.foreground": "#1e1f22",
      "editorWidget.border": "#c9ccd6",
      // Autocomplete, hovers and lists: set every colour, or Monaco keeps its white selected text.
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#c9ccd6",
      "editorSuggestWidget.foreground": "#1e1f22",
      "editorSuggestWidget.selectedBackground": "#d4e2ff",
      "editorSuggestWidget.selectedForeground": "#1e1f22",
      "editorSuggestWidget.selectedIconForeground": "#1e1f22",
      "editorSuggestWidget.highlightForeground": "#1750eb",
      "editorSuggestWidget.focusHighlightForeground": "#1750eb",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.foreground": "#1e1f22",
      "editorHoverWidget.border": "#c9ccd6",
      "list.activeSelectionBackground": "#d4e2ff",
      "list.activeSelectionForeground": "#1e1f22",
      "list.activeSelectionIconForeground": "#1e1f22",
      "list.inactiveSelectionBackground": "#e8ecf5",
      "list.inactiveSelectionForeground": "#1e1f22",
      "list.focusBackground": "#d4e2ff",
      "list.focusForeground": "#1e1f22",
      "list.hoverBackground": "#ebecf0",
      "list.hoverForeground": "#1e1f22",
      "list.highlightForeground": "#1750eb",
      "quickInput.background": "#ffffff",
      "quickInput.foreground": "#1e1f22",
      "quickInputList.focusBackground": "#d4e2ff",
      "quickInputList.focusForeground": "#1e1f22",
      "focusBorder": "#3574f0",
      "minimap.background": "#ffffff",
      "editorBracketMatch.background": "#d3d5db",
      "editorBracketMatch.border": "#00000000",
      "editorOverviewRuler.border": "#00000000",
    },
  });
}

/**
 * The editor checks TypeScript as Node runs it: each file is a module, modern
 * syntax, and Node's own modules and globals are known, so reading input with
 * require("fs") or node:readline is not marked as an error.
 */
function configureTypeScript(monaco: Monaco) {
  const ts = monaco.languages.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    ...ts.typescriptDefaults.getCompilerOptions(),
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    // Each file is its own module, as Node runs it: two files may both have a `const n`.
    moduleDetection: 3,
    allowNonTsExtensions: true,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    strict: true,
    noEmit: true,
  });
  ts.typescriptDefaults.addExtraLib(NODE_TYPES, "file:///node_modules/@types/node/index.d.ts");
  ts.javascriptDefaults.addExtraLib(NODE_TYPES, "file:///node_modules/@types/node/index.d.ts");
}

/** Monaco model URI for a project file. Keeping one model per file preserves undo history across tabs. */
export function modelUri(monaco: Monaco, projectId: string, path: string) {
  return monaco.Uri.parse(`file:///${projectId}/${path}`);
}
