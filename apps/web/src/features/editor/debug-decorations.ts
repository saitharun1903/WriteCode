"use client";

import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { canDebug } from "@/features/commands/registry";
import { useWorkspace } from "@/features/projects/store";

/**
 * Breakpoint gutter and debugger decorations for the Monaco editor.
 * Decorations are tracked ranges, so breakpoints follow their code as lines
 * are inserted or removed above them; the new positions are written back to
 * the project.
 */

interface EditorDebugState {
  breakpoints: editor.IEditorDecorationsCollection;
  hint: editor.IEditorDecorationsCollection;
  current: editor.IEditorDecorationsCollection;
  /** File the breakpoint decorations were last rendered for. */
  renderedFile: string | null;
}

const states = new WeakMap<editor.ICodeEditor, EditorDebugState>();

/** Project-relative path of the editor's current model, if it belongs to the open project. */
function fileOf(ed: editor.ICodeEditor): string | null {
  const model = ed.getModel();
  const project = useWorkspace.getState().project;
  if (!model || !project) return null;
  const prefix = `/${project.id}/`;
  return model.uri.path.startsWith(prefix) ? decodeURIComponent(model.uri.path.slice(prefix.length)) : null;
}

export function installBreakpointGutter(ed: editor.IStandaloneCodeEditor, monaco: Monaco) {
  const state: EditorDebugState = {
    breakpoints: ed.createDecorationsCollection(),
    hint: ed.createDecorationsCollection(),
    current: ed.createDecorationsCollection(),
    renderedFile: null,
  };
  states.set(ed, state);
  const { MouseTargetType } = monaco.editor;
  const inGutter = (t: editor.IMouseTarget) =>
    t.type === MouseTargetType.GUTTER_GLYPH_MARGIN || t.type === MouseTargetType.GUTTER_LINE_DECORATIONS;

  ed.onMouseDown((e) => {
    if (!inGutter(e.target) || !e.target.position || !canDebug()) return;
    const file = fileOf(ed);
    if (file) useWorkspace.getState().toggleBreakpoint(file, e.target.position.lineNumber);
  });

  // Faint dot under the pointer shows where a click would add a breakpoint.
  ed.onMouseMove((e) => {
    if (!inGutter(e.target) || !e.target.position || !canDebug()) return state.hint.clear();
    const line = e.target.position.lineNumber;
    state.hint.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "cw-bp-hint" } }]);
  });
  ed.onMouseLeave(() => state.hint.clear());

  ed.onDidChangeModel(() => {
    state.renderedFile = null;
    state.hint.clear();
  });

  ed.onDidChangeModelContent(() => {
    const file = fileOf(ed);
    if (!file || state.renderedFile !== file) return;
    const lines = state.breakpoints.getRanges().map((r) => r.startLineNumber);
    useWorkspace.getState().setBreakpoints(file, lines);
  });
}

export function renderDebugDecorations(
  ed: editor.IStandaloneCodeEditor,
  monaco: Monaco,
  input: { file: string; lines: number[]; unverified: number[]; current: { line: number; top: boolean } | null },
) {
  const state = states.get(ed);
  if (!state || fileOf(ed) !== input.file) return;
  const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

  state.breakpoints.set(
    input.lines.map((line) => {
      const unverified = input.unverified.includes(line);
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          stickiness,
          glyphMarginClassName: unverified ? "cw-bp cw-bp-unverified" : "cw-bp",
          glyphMarginHoverMessage: {
            value: unverified ? "Breakpoint not set: there is no executable code on this line." : "Breakpoint",
          },
        },
      };
    }),
  );
  state.renderedFile = input.file;

  if (input.current) {
    const { line, top } = input.current;
    state.current.set([
      {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          stickiness,
          isWholeLine: true,
          className: top ? "cw-debug-line" : "cw-debug-line-frame",
          glyphMarginClassName: top ? "cw-debug-arrow" : "cw-debug-arrow-frame",
          overviewRuler: { color: "#e8b85c", position: monaco.editor.OverviewRulerLane.Full },
        },
      },
    ]);
  } else {
    state.current.clear();
  }
}
