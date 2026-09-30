"use client";

import type { editor } from "monaco-editor";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { missingIncludes, missingJavaImports, missingPythonImports, type ImportEdit } from "./auto-import";

/** Pause after the last keystroke before imports are added. */
const DELAY_MS = 600;

/**
 * Adds missing imports shortly after typing stops. The imports are one undo
 * step of their own, so Ctrl+Z removes them without touching what was typed.
 * Nothing happens on undo/redo or when a file is loaded.
 */
export function installAutoImport(ed: editor.IStandaloneCodeEditor) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const apply = () => {
    timer = null;
    const model = ed.getModel();
    const position = ed.getPosition();
    if (!model || !position || !useSettings.getState().autoImport) return;
    const language = model.getLanguageId();
    if (!["java", "python", "c", "cpp"].includes(language)) return;
    const code = model.getValue();
    const cursor = model.getOffsetAt(position);
    let change: ImportEdit | null;
    if (language === "java") {
      const project = useWorkspace.getState().project;
      const others = project?.files.filter((f) => f.path.endsWith(".java")).map((f) => f.content) ?? [];
      change = missingJavaImports(code, [code, ...others], cursor);
    } else if (language === "python") {
      change = missingPythonImports(code, cursor);
    } else {
      change = missingIncludes(code, language === "cpp", cursor);
    }
    if (!change) return;
    const text = change.lines.join("\n") + "\n" + (change.blankAfter ? "\n" : "");
    const at = { startLineNumber: change.beforeLine, startColumn: 1, endLineNumber: change.beforeLine, endColumn: 1 };
    ed.pushUndoStop();
    ed.executeEdits("cw.autoImport", [{ range: at, text, forceMoveMarkers: false }]);
    ed.pushUndoStop();
  };

  ed.onDidChangeModelContent((e) => {
    if (e.isUndoing || e.isRedoing || e.isFlush) {
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    // Our own edit ends the chain.
    if (e.changes.every((c) => /^(?:import |from |#include )/.test(c.text))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, DELAY_MS);
  });
  // Switching files must not import into the file that was just left.
  ed.onDidChangeModel(() => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
}
