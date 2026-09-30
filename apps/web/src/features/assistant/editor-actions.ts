"use client";

import type { Monaco } from "@monaco-editor/react";
import { isRestricted } from "@/features/interview/restrict";
import type { editor, languages } from "monaco-editor";
import { askAssistant } from "@/features/commands/registry";

let installed = false;

/**
 * "Fix with AI" in the editor's quick-fix menu (the lightbulb, or Ctrl+.) on
 * lines with an error or warning, such as a compiler error from the last run.
 * Registered once per page; Monaco providers are global.
 */
export function installAiQuickFix(monaco: Monaco) {
  if (installed) return;
  installed = true;
  monaco.editor.registerCommand("cw.ai.fixMarker", (_accessor: unknown, file: string, line: number, message: string) => {
    askAssistant(`Fix the problem on line ${line} of ${file}: "${message}"`);
  });
  for (const language of ["java", "python", "c", "cpp", "javascript", "typescript"]) {
    monaco.languages.registerCodeActionProvider(language, {
      provideCodeActions(model: editor.ITextModel, _range: unknown, context: languages.CodeActionContext) {
        const marker = context.markers.find((m: editor.IMarkerData) => m.severity >= monaco.MarkerSeverity.Warning);
        if (!marker || isRestricted()) return { actions: [], dispose() {} };
        const file = decodeURIComponent(model.uri.path.split("/").slice(2).join("/"));
        return {
          actions: [
            {
              title: "Fix with AI",
              kind: "quickfix",
              isPreferred: true,
              diagnostics: [marker],
              command: { id: "cw.ai.fixMarker", title: "Fix with AI", arguments: [file, marker.startLineNumber, marker.message] },
            },
          ],
          dispose() {},
        };
      },
    });
  }
}
