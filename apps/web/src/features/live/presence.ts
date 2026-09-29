"use client";

import * as Y from "yjs";
import type { editor, IDisposable } from "monaco-editor";
import { LIVE_COLORS, type LiveParticipant, type LivePresence } from "@cw/shared";
import { currentLocation, useDebug } from "@/features/debug/store";
import { editorBridge } from "@/features/editor/bridge";
import { useWorkspace } from "@/features/projects/store";
import type { LiveClient } from "./client";
import { filesOf } from "./bind";

/** How long a name label stays next to someone's cursor after they move or type. */
const LABEL_MS = 3000;

export interface PresenceHooks {
  me: () => LiveParticipant | null;
  participants: () => LiveParticipant[];
  following: () => string | null;
  stopFollowing: () => void;
  /** Everyone else's presence, by participant id, for the people list. */
  onChange: (presence: Record<string, LivePresence>) => void;
}

function cssString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ")}"`;
}

/**
 * Publishes this person's file, selection and paused debug line, and draws
 * everyone else's cursors (with their names) in the editor. Also moves the
 * editor along with the person being followed.
 */
export function startPresence(client: LiveClient, projectId: string, hooks: PresenceHooks): () => void {
  const { doc, awareness } = client;
  const texts = filesOf(doc);
  const disposables: IDisposable[] = [];
  let decorations: editor.IEditorDecorationsCollection | null = null;
  const moved = new Map<number, number>();
  const lastSeen = new Map<number, string>();
  let labelTimer: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  const style = document.createElement("style");
  style.dataset.live = "names";
  document.head.appendChild(style);

  // ---- What I publish.
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    publishTimer = null;
    const me = hooks.me();
    if (!me) return;
    const ws = useWorkspace.getState();
    if (ws.project?.id !== projectId) return;
    const state: LivePresence = { user: { id: me.id, name: me.name, color: me.color } };
    const file = ws.activeFile ?? undefined;
    if (file) state.file = file;
    const ed = editorBridge.editor;
    const sel = ed?.getSelection();
    const model = ed?.getModel();
    const text = file ? texts.get(file) : undefined;
    if (sel && model && text && editorBridge.currentPath() === file) {
      const anchor = model.getOffsetAt(sel.getSelectionStart());
      const head = model.getOffsetAt(sel.getPosition());
      state.anchor = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, Math.min(anchor, text.length)));
      state.head = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, Math.min(head, text.length)));
    }
    const paused = currentLocation(useDebug.getState());
    if (paused) state.paused = { file: paused.file, line: paused.line };
    awareness.setLocalState(state);
  };
  const schedulePublish = () => {
    publishTimer ??= setTimeout(publish, 60);
  };

  disposables.push({
    dispose: editorBridge.onAttach((ed) => {
      disposables.push(ed.onDidChangeCursorSelection(schedulePublish));
      disposables.push(ed.onDidChangeModel(() => {
        schedulePublish();
        render();
      }));
      // Taking over the keyboard or mouse stops following someone.
      disposables.push(ed.onMouseDown(() => hooks.following() && hooks.stopFollowing()));
      disposables.push(ed.onKeyDown(() => hooks.following() && hooks.stopFollowing()));
      decorations = ed.createDecorationsCollection();
      render();
    }),
  });
  const unsubWorkspace = useWorkspace.subscribe((s, prev) => {
    if (s.activeFile !== prev.activeFile) schedulePublish();
  });
  const unsubDebug = useDebug.subscribe((s, prev) => {
    if (s.stop !== prev.stop || s.selectedFrame !== prev.selectedFrame) schedulePublish();
  });

  // ---- Everyone else.
  const absolute = (json: unknown, text: Y.Text): number | null => {
    if (!json) return null;
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
      return pos && pos.type === text ? pos.index : null;
    } catch {
      return null;
    }
  };

  const others = (): { clientId: number; state: LivePresence; who: LiveParticipant }[] => {
    const people = new Map(hooks.participants().map((p) => [p.id, p]));
    const me = hooks.me();
    const out = [];
    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === doc.clientID) continue;
      const state = raw as LivePresence;
      // Names and colours come from the server's list, never from what a browser claims.
      const who = state?.user?.id ? people.get(state.user.id) : undefined;
      if (!who || who.id === me?.id) continue;
      out.push({ clientId, state, who });
    }
    return out;
  };

  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  function draw() {
    const ed = editorBridge.editor;
    const model = ed?.getModel();
    const path = editorBridge.currentPath();
    const monaco = editorBridge.monaco;
    if (!ed || !model || !path || !monaco || useWorkspace.getState().project?.id !== projectId) {
      decorations?.clear();
      return;
    }
    if (!decorations) decorations = ed.createDecorationsCollection();
    const text = texts.get(path);
    const now = Date.now();
    const list: editor.IModelDeltaDecoration[] = [];
    let css = "";
    for (const { clientId, state, who } of others()) {
      const color = who.color % LIVE_COLORS.length;
      css += `.cw-live-n-${who.id}::after{content:${cssString(who.name)}}`;
      if (state.paused?.file === path && state.paused.line <= model.getLineCount()) {
        list.push({
          range: new monaco.Range(state.paused.line, 1, state.paused.line, 1),
          options: { isWholeLine: true, className: `cw-live-paused cw-live-c${color}`, glyphMarginClassName: `cw-live-paused-glyph cw-live-c${color}`, glyphMarginHoverMessage: { value: `${who.name}'s program is paused here` } },
        });
      }
      if (state.file !== path || !text) continue;
      const head = absolute(state.head, text);
      if (head === null) continue;
      const anchor = absolute(state.anchor, text) ?? head;
      const h = model.getPositionAt(head);
      if (anchor !== head) {
        const a = model.getPositionAt(anchor);
        const [s, e] = anchor < head ? [a, h] : [h, a];
        list.push({ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), options: { className: `cw-live-sel cw-live-c${color}`, stickiness: 1 } });
      }
      const recent = now - (moved.get(clientId) ?? 0) < LABEL_MS || hooks.following() === who.id;
      list.push({
        range: new monaco.Range(h.lineNumber, h.column, h.lineNumber, h.column),
        options: {
          beforeContentClassName: `cw-live-caret cw-live-c${color}${recent ? ` cw-live-label cw-live-n-${who.id}${h.lineNumber === 1 ? " cw-live-below" : ""}` : ""}`,
          stickiness: 1,
          hoverMessage: { value: who.name },
        },
      });
    }
    if (style.textContent !== css) style.textContent = css;
    decorations.set(list);
  }

  // ---- Following someone: open the file they are in and keep their cursor in view.
  let followedAt: string | null = null;
  const follow = () => {
    const id = hooks.following();
    if (!id) return void (followedAt = null);
    const target = others().find((o) => o.who.id === id);
    if (!target?.state.file) return;
    const ws = useWorkspace.getState();
    if (!ws.project?.files.some((f) => f.path === target.state.file)) return;
    const text = texts.get(target.state.file);
    const head = text ? absolute(target.state.head, text) : null;
    const line = head !== null ? (text!.toString().slice(0, head).match(/\n/g)?.length ?? 0) + 1 : null;
    const where = `${target.state.file}:${line}`;
    if (where === followedAt) return;
    followedAt = where;
    if (ws.activeFile !== target.state.file) {
      if (line) editorBridge.revealAfterSwitch(line, 1, false);
      ws.openFile(target.state.file);
    } else if (line) {
      editorBridge.showLine(line);
    }
  };

  const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const now = Date.now();
    for (const id of [...added, ...updated]) {
      if (id === doc.clientID) continue;
      const state = awareness.getStates().get(id) as LivePresence | undefined;
      // A label shows when the cursor actually moved, not on the periodic keep-alive.
      const sig = JSON.stringify([state?.file, state?.head, state?.anchor]);
      if (lastSeen.get(id) !== sig) moved.set(id, now);
      lastSeen.set(id, sig);
    }
    for (const id of removed) {
      moved.delete(id);
      lastSeen.delete(id);
    }
    const byPerson: Record<string, LivePresence> = {};
    for (const o of others()) byPerson[o.who.id] = o.state;
    hooks.onChange(byPerson);
    follow();
    render();
    if (labelTimer) clearTimeout(labelTimer);
    labelTimer = setTimeout(render, LABEL_MS + 50);
  };
  awareness.on("change", onAwareness);
  // Text changes move cursors; redraw after them.
  const onDocChange = () => render();
  doc.on("afterTransaction", onDocChange);
  publish();

  return () => {
    awareness.off("change", onAwareness);
    doc.off("afterTransaction", onDocChange);
    unsubWorkspace();
    unsubDebug();
    for (const d of disposables) d.dispose();
    decorations?.clear();
    cancelAnimationFrame(frame);
    if (publishTimer) clearTimeout(publishTimer);
    if (labelTimer) clearTimeout(labelTimer);
    style.remove();
    awareness.setLocalState(null);
  };
}

