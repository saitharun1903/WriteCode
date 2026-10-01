"use client";

import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { findEntryPoints, getLanguage, monacoLanguageForPath } from "@cw/shared";
import { Spinner } from "@/components/ui/primitives";
import { currentLocation, frameKey, useDebug } from "@/features/debug/store";
import { inlineValues, previewOf, shortValue } from "@/features/debug/inline-values";
import { previousLocation, stepLocation, useVisualize } from "@/features/visualize/store";
import { useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useResolvedTheme, useSettings } from "@/features/settings/store";
import { applyCodeFont, codeFontFamily } from "@/features/settings/fonts";
import { runCommand } from "@/features/commands/registry";
import { installAiQuickFix } from "@/features/assistant/editor-actions";
import { defineThemes, modelUri } from "./monaco-setup";
import { installAutoImport } from "./auto-import-editor";
import { installSnippets } from "./snippets";
import { editorBridge } from "./bridge";
import { installBreakpointGutter, renderDebugDecorations } from "./debug-decorations";
import { COMPACT_QUERY, useMediaQuery } from "@/lib/use-media";
import { liveHistory } from "@/features/live/store";
import { isRestricted, useRestriction } from "@/features/interview/restrict";

const NO_LINES: number[] = [];

export function CodeEditor() {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const diagnostics = useExecution((s) => s.diagnostics);
  const resolvedTheme = useResolvedTheme();
  const { fontSize, codeFont: codeFontId, tabSize, wordWrap, minimap, autoClose, suggestions, bracketColors } = useSettings();
  const compact = useMediaQuery(COMPACT_QUERY);
  const readOnly = useWorkspace((s) => s.readOnly);
  // An interview candidate writes the code alone: nothing is suggested, completed or looked up.
  const restricted = useRestriction((s) => s.restricted);
  const restrictedKey = useRef<{ set(value: boolean): void } | null>(null);
  const phone = useMediaQuery("(max-width: 639px)");

  // Monaco measures glyphs itself, so it gets the concrete family names of the chosen font,
  // and measures again once the font's file has arrived.
  const codeFont = useMemo(() => codeFontFamily(codeFontId), [codeFontId]);
  useEffect(() => {
    applyCodeFont(codeFontId);
    let live = true;
    void document.fonts
      ?.load(`14px ${codeFont}`)
      .catch(() => [])
      .then(() => live && editorBridge.monaco?.editor.remeasureFonts());
    return () => {
      live = false;
    };
  }, [codeFontId, codeFont]);
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
  // The visualizer's step is shown while its tool window is open and no debug session is paused.
  const vizOpen = useSettings((s) => s.layout.bottomOpen && s.layout.bottomTab === "visualize");
  const vizFile = useVisualize((s) => stepLocation(s)?.file ?? null);
  const vizLine = useVisualize((s) => stepLocation(s)?.line ?? null);
  const vizRanFile = useVisualize((s) => previousLocation(s)?.file ?? null);
  const vizRanLine = useVisualize((s) => previousLocation(s)?.line ?? null);
  const showViz = !pausedLine && vizOpen;
  const currentLine = currentFile === activeFile ? pausedLine : showViz && vizFile === activeFile ? vizLine : null;
  // Variables of the paused frame, as a string so the selector stays stable between renders.
  const inlineKey = useDebug((s) => {
    const frame = s.stop?.frames[s.selectedFrame];
    const locals = frame ? s.variables[frame.localsRef] : undefined;
    if (!frame?.file || frame.file !== activeFile || locals?.status !== "ready") return "";
    const previous = s.previous?.frame === frameKey(s.stop!.frames, s.selectedFrame) ? s.previous.values : null;
    return JSON.stringify(
      locals.variables.map((v) => {
        const children = v.ref ? s.variables[v.ref] : undefined;
        const value = (children?.status === "ready" ? previewOf(children.variables, 6) : null) ?? v.value;
        return { name: v.name, value: shortValue(value), changed: !!previous && previous[v.name] !== undefined && previous[v.name] !== v.value };
      }),
    );
  });
  const ranLine = showViz && vizRanFile === activeFile ? vizRanLine : null;
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
    // In a live session, undo takes back only your own changes, never someone else's.
    const history = (which: "undo" | "redo") => {
      if (liveHistory(which, editorBridge.currentPath()) === null) ed.trigger("keyboard", which, null);
    };
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => history("undo"));
    ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => history("redo"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => history("redo"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyJ, () => runCommand("view.toggleBottomPanel"));
    ed.addCommand(KeyMod.CtrlCmd | KeyCode.KeyB, () => runCommand("view.toggleSidebar"));
    // For an interview candidate, the keys that ask for suggestions, hints, quick fixes and the editor's own command list do nothing.
    restrictedKey.current = ed.createContextKey<boolean>("cwRestricted", isRestricted());
    const nothing = () => {};
    for (const key of [KeyMod.CtrlCmd | KeyCode.Space, KeyMod.CtrlCmd | KeyCode.KeyI, KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space, KeyMod.CtrlCmd | KeyCode.Period, KeyMod.Alt | KeyCode.Backslash, KeyCode.F1, KeyCode.F12, KeyMod.Alt | KeyCode.F12]) {
      ed.addCommand(key, nothing, "cwRestricted");
    }

    ed.onDidChangeCursorPosition((e) => editorBridge.setCursor(e.position.lineNumber, e.position.column));
    // Right-click menu: ask the assistant about the code under the cursor.
    ed.addAction({ id: "cw.ai.explainSelection", label: "Ask AI: Explain Selection", contextMenuGroupId: "0_ai", contextMenuOrder: 1, precondition: "editorHasSelection", run: () => void runCommand("assistant.explainSelection") });
    ed.addAction({ id: "cw.ai.findBugs", label: "Ask AI: Find Bugs in This File", contextMenuGroupId: "0_ai", contextMenuOrder: 2, run: () => void runCommand("assistant.findBugs") });
    installBreakpointGutter(ed, monaco);
    installAiQuickFix(monaco);
    installSnippets(monaco);
    installAutoImport(ed);
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

  useEffect(() => {
    restrictedKey.current?.set(restricted);
  }, [restricted, mounted]);

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
      ran: ranLine,
      inline: inlineKey && pausedLine && content !== undefined ? inlineValues(content.split("\n"), pausedLine, JSON.parse(inlineKey)) : undefined,
      runLines: runLinesKey ? runLinesKey.split(",").map(Number) : [],
    });
  }, [mounted, activeFile, fileBreakpoints, unverified, currentLine, currentTop, ranLine, runLinesKey, inlineKey, pausedLine, content]);

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
      theme={resolvedTheme === "light" ? "cw-light" : "cw-dark"}
      beforeMount={defineThemes}
      onMount={handleMount}
      loading={
        <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-subtle">
          <Spinner /> Loading editor…
        </div>
      }
      options={{
        readOnly,
        readOnlyMessage: { value: "View only: the owner of this live session has not given you edit access." },
        fontFamily: codeFont,
        fontSize,
        fontLigatures: false,
        lineHeight: Math.round(fontSize * 1.45),
        tabSize,
        insertSpaces: true,
        detectIndentation: false,
        // A phone shows some twenty characters across: long lines wrap there, so no code is off the screen.
        wordWrap: wordWrap || phone ? "on" : "off",
        minimap: { enabled: minimap && !compact, renderCharacters: false, scale: 1, maxColumn: 100 },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "blink",
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "line",
        bracketPairColorization: { enabled: bracketColors },
        guides: { bracketPairs: bracketColors ? "active" : false, indentation: true },
        autoClosingBrackets: autoClose ? "languageDefined" : "never",
        autoClosingQuotes: autoClose ? "languageDefined" : "never",
        quickSuggestions: suggestions && !restricted ? { other: true, comments: false, strings: false } : false,
        suggestOnTriggerCharacters: suggestions && !restricted,
        wordBasedSuggestions: restricted ? "off" : "matchingDocuments",
        snippetSuggestions: restricted ? "none" : "inline",
        parameterHints: { enabled: !restricted },
        inlineSuggest: { enabled: !restricted },
        tabCompletion: "off",
        acceptSuggestionOnEnter: restricted ? "off" : "on",
        hover: { enabled: restricted ? "off" : "on" },
        lightbulb: { enabled: (restricted ? "off" : "onCode") as editor.ShowLightbulbIconMode },
        contextmenu: !restricted,
        dropIntoEditor: { enabled: !restricted },
        pasteAs: { enabled: !restricted },
        links: !restricted,
        // Phones and tablets: the last lines can scroll up from under the floating dock.
        padding: { top: 6, bottom: compact ? 108 : 6 },
        lineDecorationsWidth: compact ? 10 : 18,
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
