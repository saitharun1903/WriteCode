"use client";

import * as Y from "yjs";
import type { editor } from "monaco-editor";
import type { Project } from "@cw/shared";
import { useWorkspace } from "@/features/projects/store";
import { editorBridge } from "@/features/editor/bridge";
import { modelUri } from "@/features/editor/monaco-setup";

/** Origin of changes this browser makes, so they are not applied back to it. */
export const LOCAL = Symbol("local");

export const filesOf = (doc: Y.Doc) => doc.getMap<Y.Text>("files");
export const foldersOf = (doc: Y.Doc) => doc.getMap<boolean>("folders");
export const metaOf = (doc: Y.Doc) => doc.getMap<unknown>("meta");

export const isReady = (doc: Y.Doc) => metaOf(doc).get("ready") === true;

type Shared = Pick<Project, "files" | "folders" | "entryFile" | "stdin" | "name">;

/** Puts a project into an empty shared document (the owner starting a session). */
export function writeProject(doc: Y.Doc, project: Project) {
  doc.transact(() => {
    const meta = metaOf(doc);
    meta.set("name", project.name);
    meta.set("language", project.language);
    meta.set("entryFile", project.entryFile);
    meta.set("stdin", project.stdin);
    const files = filesOf(doc);
    for (const f of project.files) {
      const text = new Y.Text();
      text.insert(0, f.content);
      files.set(f.path, text);
    }
    for (const folder of project.folders) foldersOf(doc).set(folder, true);
    meta.set("ready", true);
  }, LOCAL);
}

/** The project as the shared document has it; files keep `order` where they appear in it. */
export function readProject(doc: Y.Doc, order: readonly string[] = []): Shared & { language: string } {
  const meta = metaOf(doc);
  const texts = filesOf(doc);
  const known = order.filter((p) => texts.has(p));
  const added = [...texts.keys()].filter((p) => !known.includes(p)).sort();
  return {
    name: String(meta.get("name") ?? "Live project"),
    language: String(meta.get("language") ?? ""),
    entryFile: String(meta.get("entryFile") ?? ""),
    stdin: String(meta.get("stdin") ?? ""),
    files: [...known, ...added].map((path) => ({ path, content: texts.get(path)!.toString() })),
    folders: [...foldersOf(doc).keys()].sort(),
  };
}

/** Changes `text` into `next` with one delete and one insert covering only what differs. */
export function applyTextDiff(text: Y.Text, next: string) {
  const cur = text.toString();
  if (cur === next) return;
  let p = 0;
  const max = Math.min(cur.length, next.length);
  while (p < max && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < cur.length - p && s < next.length - p && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  // Never split a character made of two UTF-16 units (emoji and the like).
  const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  if (p > 0 && high(cur.charCodeAt(p - 1))) p--;
  if (s > 0 && high(cur.charCodeAt(cur.length - s - 1))) s--;
  const removed = cur.length - p - s;
  if (removed > 0) text.delete(p, removed);
  const inserted = next.slice(p, next.length - s);
  if (inserted) text.insert(p, inserted);
}

/** Copies what changed between two versions of the project into the shared document. */
function pushChanges(doc: Y.Doc, prev: Project, next: Project) {
  doc.transact(() => {
    const texts = filesOf(doc);
    const before = new Map(prev.files.map((f) => [f.path, f.content]));
    const after = new Map(next.files.map((f) => [f.path, f.content]));
    for (const path of before.keys()) if (!after.has(path)) texts.delete(path);
    for (const [path, content] of after) {
      const text = texts.get(path);
      if (!text) {
        const created = new Y.Text();
        created.insert(0, content);
        texts.set(path, created);
      } else if (before.get(path) !== content) {
        applyTextDiff(text, content);
      }
    }
    if (prev.folders !== next.folders) {
      const folders = foldersOf(doc);
      for (const f of [...folders.keys()]) if (!next.folders.includes(f)) folders.delete(f);
      for (const f of next.folders) if (!folders.has(f)) folders.set(f, true);
    }
    const meta = metaOf(doc);
    if (prev.entryFile !== next.entryFile) meta.set("entryFile", next.entryFile);
    if (prev.stdin !== next.stdin) meta.set("stdin", next.stdin);
    if (prev.name !== next.name) meta.set("name", next.name);
  }, LOCAL);
}

type Monaco = NonNullable<typeof editorBridge.monaco>;

function monacoInstance(): Monaco | null {
  return editorBridge.monaco ?? ((globalThis as { monaco?: Monaco }).monaco ?? null);
}

/**
 * Applies another person's change to an open editor model as precise edits,
 * so your cursor and scroll position stay where they are. Returns the offset
 * just after the change (to place the cursor after an undo).
 */
function applyToModel(model: editor.ITextModel, delta: Y.YTextEvent["delta"], expected: string): number | null {
  const edits: { start: number; end: number; text: string }[] = [];
  let index = 0;
  for (const op of delta) {
    if (op.retain) {
      index += op.retain;
    } else if (typeof op.insert === "string") {
      const last = edits.at(-1);
      if (last && last.end === index) last.text += op.insert;
      else edits.push({ start: index, end: index, text: op.insert });
    } else if (op.delete) {
      const last = edits.at(-1);
      if (last && last.end === index) last.end += op.delete;
      else edits.push({ start: index, end: index + op.delete, text: "" });
      index += op.delete;
    }
  }
  const range = (a: number, b: number) => {
    const s = model.getPositionAt(a);
    const e = model.getPositionAt(b);
    return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column };
  };
  model.applyEdits(edits.map((e) => ({ range: range(e.start, e.end), text: e.text })));
  // If the model had drifted from the shared text, fall back to replacing what differs.
  if (model.getValue() !== expected) model.applyEdits([{ range: model.getFullModelRange(), text: expected }]);
  const last = edits.at(-1);
  if (!last) return null;
  let shift = 0;
  for (const e of edits.slice(0, -1)) shift += e.text.length - (e.end - e.start);
  return last.start + shift + last.text.length;
}

export interface Binding {
  /** Undo / redo this person's own last change in the open file. False when there is none. */
  undo: (path: string) => boolean;
  redo: (path: string) => boolean;
  unbind: () => void;
}

/**
 * Keeps the open project, its editor models and the shared document in step.
 * Local changes (typing, file operations, the assistant) flow into the
 * document; changes from others flow into the models and the project.
 */
export function bindProject(doc: Y.Doc, projectId: string, writable: () => boolean): Binding {
  let applying = false;
  const texts = filesOf(doc);
  const undoers = new Map<Y.Text, Y.UndoManager>();
  const undoerFor = (text: Y.Text) => {
    let um = undoers.get(text);
    if (!um) {
      um = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });
      undoers.set(text, um);
    }
    return um;
  };
  for (const text of texts.values()) undoerFor(text);
  let lastChangeEnd: { path: string; offset: number } | null = null;

  const unsubscribeStore = useWorkspace.subscribe((s, prev) => {
    if (applying || !s.project || !prev.project || s.project.id !== projectId || prev.project.id !== projectId || s.project === prev.project) return;
    if (!writable()) return;
    pushChanges(doc, prev.project, s.project);
    for (const text of texts.values()) undoerFor(text);
  });

  // Others' text changes, applied to open models as they arrive.
  const onDeep = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction) => {
    if (txn.origin === LOCAL) return;
    const monaco = monacoInstance();
    if (!monaco) return;
    applying = true;
    try {
      for (const e of events) {
        if (!(e instanceof Y.YTextEvent)) continue;
        const path = String(e.path[0] ?? "");
        const model = monaco.editor.getModel(modelUri(monaco, projectId, path));
        if (!model) continue;
        const end = applyToModel(model, e.delta, (e.target as Y.Text).toString());
        if (end !== null) lastChangeEnd = { path, offset: end };
      }
    } finally {
      applying = false;
    }
  };
  texts.observeDeep(onDeep);

  // Then the project itself: file list, folders, entry file, input, name.
  const onTransaction = (txn: Y.Transaction) => {
    if (txn.origin === LOCAL || txn.changed.size === 0) return;
    const ws = useWorkspace.getState();
    if (ws.project?.id !== projectId) return;
    const shared = readProject(doc, ws.project.files.map((f) => f.path));
    const p = ws.project;
    const same =
      shared.entryFile === p.entryFile &&
      shared.stdin === p.stdin &&
      shared.name === p.name &&
      shared.folders.join("\n") === [...p.folders].sort().join("\n") &&
      shared.files.length === p.files.length &&
      shared.files.every((f, i) => p.files[i]!.path === f.path && p.files[i]!.content === f.content);
    for (const text of texts.values()) undoerFor(text);
    if (same) return;
    applying = true;
    try {
      ws.applyShared({ files: shared.files, folders: shared.folders, entryFile: shared.entryFile, stdin: shared.stdin, name: shared.name });
    } finally {
      applying = false;
    }
  };
  doc.on("afterTransaction", onTransaction);

  const step = (path: string, which: "undo" | "redo") => {
    const text = texts.get(path);
    const um = text && undoers.get(text);
    if (!um || (which === "undo" ? !um.canUndo() : !um.canRedo())) return false;
    lastChangeEnd = null;
    if (which === "undo") um.undo();
    else um.redo();
    // Put the cursor where the change happened, as a normal undo does.
    const end = lastChangeEnd as { path: string; offset: number } | null;
    const ed = editorBridge.editor;
    const model = ed?.getModel();
    if (ed && model && end && end.path === path) {
      const pos = model.getPositionAt(end.offset);
      ed.setPosition(pos);
      ed.revealPositionInCenterIfOutsideViewport(pos);
    }
    return true;
  };

  return {
    undo: (path) => step(path, "undo"),
    redo: (path) => step(path, "redo"),
    unbind() {
      unsubscribeStore();
      texts.unobserveDeep(onDeep);
      doc.off("afterTransaction", onTransaction);
      for (const um of undoers.values()) um.destroy();
      undoers.clear();
    },
  };
}
