"use client";

import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { findEntryPoints, getLanguage, monacoLanguageForPath } from "@cw/shared";
import { Spinner } from "@/components/ui/primitives";
import { currentLocation, useDebug } from "@/features/debug/store";
import { useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { resolveTheme, useSettings } from "@/features/settings/store";
import { runCommand } from "@/features/commands/registry";
import { defineThemes, modelUri } from "./monaco-setup";
import { editorBridge } from "./bridge";
import { installBreakpointGutter, renderDebugDecorations } from "./debug-decorations";
import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";

const NO_LINES: number[] = [];

export function CodeEditor() {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const diagnostics = useExecution((s) => s.diagnostics);
  const { theme, fontSize, tabSize, wordWrap, minimap } = useSettings();
  const compact = useMediaQuery(COMPACT_QUERY);

  // Monaco measures glyphs itself, so give it the concrete family name next/font generated.
  const [codeFont] = useState(() => {
    const v = typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim();
    return `${v ? `${v}, ` : ""}"JetBrains Mono", Consolas, monospace`;
  });
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [mounted, setMounted] = useState(false);

  const file = project?.files.find((f) => f.path === activeFile);
  const debuggable = !!project && (getLanguage(project.language)?.debugger?.supportLevel ?? "planned") !== "planned";
  const fileBreakpoints = (activeFile && project?.breakpoints?.[activeFile]) || NO_LINES;
  const unverified = useDebug((s) => (activeFile && s.unverified[activeFile]) || NO_LINES);
  // Select primitives: a fresh object per render would loop zustand's subscription.
  const currentFile = useDebug((s) => currentLocation(s)?.file ?? null);
  const pausedLine = useDebug((s) => currentLocation(s)?.line ?? null);
  const currentTop = useDebug((s) => currentLocation(s)?.top ?? true);
  const currentLine = currentFile === activeFile ? pausedLine : null;
  const language = project?.language;
  const content = file?.content;
  // A string key keeps the decorations effect from re-running when unrelated text changes.
  const runLinesKey =
    language && activeFile && content !== undefined ? findEntryPoints(language, [{ path: activeFile, content }]).map((e) => e.line).join(",") : "";

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
    editorBridge.attach(ed, monaco);

    const { KeyMod, KeyCode } = monaco;
    // Route IDE shortcuts through the command registry even while the editor has focus.
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => runCommand("run.execute"));
    ed.addCommand(KeyCode.F5, () => runCommand("debug.startOrContinue"));
    ed.addCommand(KeyMod.Shift | KeyCode.F5, () => runCommand("run.cancel"));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F5, () => runCommand("debug.restart"));
    ed.addCommand(KeyCode.F6, () => runCommand("debug.pause"));
    ed.addCommand(KeyCode.F9, () => runCommand("debug.toggleBreakpoint"));
    ed.addCommand(KeyCode.F10, () => runCommand("debug.stepOver"));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.F10, () => runCommand("run.currentFile"));
    ed.addCommand(KeyCode.F11, () => runCommand("debug.stepIn"));
    ed.addCommand(KeyMod.Shift | KeyCode.F11, () => runCommand("debug.stepOut"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => runCommand("file.save"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyP, () => runCommand("workbench.quickOpen"));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, () => runCommand("workbench.commandPalette"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyJ, () => runCommand("view.toggleBottomPanel"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyB, () => runCommand("view.toggleSidebar"));

    ed.onDidChangeCursorPosition((e) => editorBridge.setCursor(e.position.lineNumber, e.position.column));
    installBreakpointGutter(ed, monaco);
    setMounted(true);

    // Subscribe here rather than via the `onChange` prop: the wrapper attaches that in an
    // effect after mount, so keystrokes typed immediately after load could be missed.
    ed.onDidChangeModelContent(() => {
      const model = ed.getModel();
      const project = useWorkspace.getState().project;
      if (!model || !project) return;
      const prefix = `/${project.id}/`;
      if (!model.uri.path.startsWith(prefix)) return;
      useWorkspace.getState().updateFile(decodeURIComponent(model.uri.path.slice(prefix.length)), model.getValue());
    });
  };

  useEffect(() => () => editorBridge.detach(), []);

  // Breakpoints and the paused line. Re-applied when the file, breakpoints or stop location change.
  useEffect(() => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!mounted || !ed || !monaco || !activeFile) return;
    renderDebugDecorations(ed, monaco, {
      file: activeFile,
      lines: fileBreakpoints,
      unverified,
      current: currentLine ? { line: currentLine, top: currentTop } : null,
      runLines: runLinesKey ? runLinesKey.split(",").map(Number) : [],
    });
  }, [mounted, activeFile, fileBreakpoints, unverified, currentLine, currentTop, runLinesKey]);

  // Drop models for files that no longer exist (deleted, renamed, other project).
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !project) return;
    const live = new Set(project.files.map((f) => modelUri(monaco, project.id, f.path).toString()));
    for (const model of monaco.editor.getModels()) {
      if (!live.has(model.uri.toString()) && model.uri.scheme === "file") model.dispose();
    }
  }, [project]);

  // Mirror parsed compiler/runtime diagnostics into Monaco markers.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco || !project) return;
    for (const f of project.files) {
      const model = monaco.editor.getModel(modelUri(monaco, project.id, f.path));
      if (!model) continue;
      const markers = diagnostics
        .filter((d) => d.file === f.path)
        .map((d) => {
          const line = Math.min(Math.max(d.line, 1), model.getLineCount());
          const col = d.column ?? model.getLineFirstNonWhitespaceColumn(line) ?? 1;
          return {
            severity:
              d.severity === "error"
                ? monaco.MarkerSeverity.Error
                : d.severity === "warning"
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
            message: d.message,
            startLineNumber: line,
            startColumn: Math.max(col, 1),
            endLineNumber: line,
            endColumn: d.column ? d.column + 1 : model.getLineMaxColumn(line),
            source: d.source,
          };
        });
      monaco.editor.setModelMarkers(model, "execution", markers);
    }
  }, [diagnostics, project, activeFile]);

  if (!project || !file) return null;

  return (
    <Editor
      key={project.id}
      path={`file:///${project.id}/${file.path}`}
      value={file.content}
      language={monacoLanguageForPath(file.path)}
      theme={resolveTheme(theme) === "light" ? "cw-light" : "cw-dark"}
      beforeMount={defineThemes}
      onMount={handleMount}
      loading={
        <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-subtle">
          <Spinner /> Loading editor…
        </div>
      }
      options={{
        fontFamily: codeFont,
        fontSize,
        fontLigatures: false,
        lineHeight: Math.round(fontSize * 1.45),
        tabSize,
        insertSpaces: true,
        detectIndentation: false,
        wordWrap: wordWrap ? "on" : "off",
        minimap: { enabled: minimap && !compact, renderCharacters: false, scale: 1, maxColumn: 100 },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "blink",
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "line",
        bracketPairColorization: { enabled: false },
        guides: { bracketPairs: false, indentation: true },
        padding: { top: 6, bottom: 6 },
        lineDecorationsWidth: 18,
        stickyScroll: { enabled: true },
        folding: true,
        glyphMargin: debuggable,
        lineNumbersMinChars: 3,
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        fixedOverflowWidgets: true,
        "semanticHighlighting.enabled": true,
      }}
    />
  );
}
