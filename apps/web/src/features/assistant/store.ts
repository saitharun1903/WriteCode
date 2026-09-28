"use client";

import { create } from "zustand";
import type { AssistantContext, AssistantEffort, AssistantEvent, AssistantMessage, AssistantRun, AssistantStep } from "@cw/shared";
import { editorBridge, useCursor } from "@/features/editor/bridge";
import { writeFile } from "@/features/editor/write-file";
import { API_URL } from "@/features/execution/api";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { diffSteps, preview } from "@/features/visualize/model";
import { resolveEdit, type EditBlock, type ResolvedHunk } from "./edits";
import { useVisualize } from "@/features/visualize/store";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** User questions: a short version shown in the chat when the full question carries long details. */
  display?: string;
  /** Assistant message still streaming. */
  pending?: boolean;
  /** Why the answer failed, shown instead of (or after) the text. */
  error?: string;
  /** Summaries of the model's reasoning, streamed before the answer. */
  thinking?: string;
  startedAt?: number;
  /** How long the model thought before answering, once the answer started. */
  thoughtMs?: number;
  /** Effort the answer was asked with. */
  effort?: AssistantEffort;
}

/** An edit from an answer that the user applied, so it can be undone. */
export interface AppliedEdit {
  file: string;
  before: string | null;
  after: string;
  hunks: ResolvedHunk[];
}

interface AssistantState {
  /** null until the server has been asked. */
  available: boolean | null;
  messages: ChatMessage[];
  streaming: boolean;
  /** Project the conversation is about; a different project starts a new chat. */
  projectId: string | null;
  /** How hard the assistant thinks: faster (low) to smarter (high). Remembered per browser. */
  effort: AssistantEffort;
  setEffort: (effort: AssistantEffort) => void;
  checkAvailability: () => Promise<void>;
  /** `display` is what the chat shows for the question when `text` carries long details (code, logs). */
  ask: (text: string, display?: string) => Promise<void>;
  /** Asks the previous question again after a failure. */
  retry: () => void;
  stop: () => void;
  clear: () => void;
  /** Applied edits by `${messageId}:${blockIndex}`. */
  applied: Record<string, AppliedEdit>;
  /** Applies an edit block to the project; returns an error message, or null on success. */
  applyEdit: (key: string, block: EditBlock) => Promise<string | null>;
  undoEdit: (key: string) => Promise<string | null>;
}

/** The project file an edit names: exact path, else a unique file with that name. */
export function editTarget(path: string): string | null {
  const files = useWorkspace.getState().project?.files ?? [];
  if (files.some((f) => f.path === path)) return path;
  const name = path.split("/").pop();
  const same = files.filter((f) => f.path.split("/").pop() === name);
  return same.length === 1 ? same[0]!.path : null;
}

/** Shows `path` in the editor, waiting (briefly) for the switch to happen. */
let controller: AbortController | null = null;
let counter = 0;
const nextId = () => `m${Date.now().toString(36)}${counter++}`;

const tail = (s: string, max: number) => (s.length > max ? s.slice(-max) : s);

/** The last run of this project as the IDE shows it: status, output and errors. */
function lastRun(projectId: string): AssistantRun | undefined {
  const run = useExecution.getState().run;
  if (!run || run.projectId !== projectId || run.status === "SUBMITTING") return undefined;
  const text = (streams: string[]) =>
    run.log
      .filter((c) => streams.includes(c.stream))
      .map((c) => c.text)
      .join("");
  const status = isRunning(run) ? `still running (${run.status})` : (run.result?.status ?? run.status);
  return {
    mode: run.mode === "debug" ? "debug" : run.mode === "visualize" ? "visualize" : "run",
    status,
    message: run.result?.message ?? run.error?.title,
    exitCode: run.result?.exitCode ?? null,
    stdout: tail(run.result?.stdout || text(["stdout"]), 12_000),
    stderr: tail([run.result?.compileOutput, run.result?.stderr].filter(Boolean).join("\n") || text(["stderr", "compile"]), 12_000),
    stdin: tail(text(["stdin"]), 4_000) || undefined,
    entry: run.entry,
  };
}

/** The visualizer step on screen, when the visualizer is open: recorded values, not guesses. */
function visualizerStep(): AssistantStep | undefined {
  const { layout } = useSettings.getState();
  const { trace, step: index } = useVisualize.getState();
  const step = trace?.steps[index];
  if (!trace || !step || !layout.bottomOpen || layout.bottomTab !== "visualize") return undefined;
  const top = step.frames[step.frames.length - 1];
  if (!top) return undefined;
  const diff = diffSteps(trace, index);
  const state = step.frames
    .map((f) => {
      const vars = f.locals.map(([n, v]) => `  ${n} = ${preview(step, v)}`);
      if (f.returnValue && f.name !== "<module>") vars.push(`  (returning ${preview(step, f.returnValue)})`);
      return `${f.name} (line ${f.line})\n${vars.join("\n") || "  (no variables)"}`;
    })
    .join("\n");
  return {
    step: index + 1,
    total: trace.steps.length,
    file: top.file,
    line: top.line,
    event: step.event,
    ranLine: diff.ranLine?.line,
    happened: diff.changes.map((c) => c.parts.map((p) => (typeof p === "string" ? p : p.code)).join("")),
    state: tail(state, 15_000),
    output: tail(trace.stdout.slice(0, step.stdoutLength), 8_000),
  };
}

/** Everything the assistant should know, taken from what the user can see in the IDE. */
export function buildContext(): AssistantContext | null {
  const { project, activeFile } = useWorkspace.getState();
  if (!project) return null;
  const selection = editorBridge.selection();
  // Keep well inside the server's size limit: the open file always goes in full.
  let budget = 150_000;
  const files = [...project.files]
    .sort((a, b) => Number(b.path === activeFile) - Number(a.path === activeFile))
    .filter((f) => {
      if (f.content.length > budget) return false;
      budget -= f.content.length;
      return true;
    })
    .slice(0, 40)
    .map((f) => ({ path: f.path, content: f.content }));
  return {
    language: project.language,
    files,
    activeFile: activeFile ?? undefined,
    cursorLine: activeFile ? useCursor.getState().line : undefined,
    selection: selection && activeFile && selection.text.trim() ? { file: activeFile, ...selection, text: selection.text.slice(0, 7_500) } : undefined,
    lastRun: lastRun(project.id),
    visualizer: visualizerStep(),
  };
}

/** Parses a server-sent event stream into assistant events. */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as AssistantEvent;
    }
  }
}

const EFFORT_KEY = "cw:ai-effort";

function savedEffort(): AssistantEffort {
  try {
    const v = localStorage.getItem(EFFORT_KEY);
    if (v === "low" || v === "medium" || v === "high") return v;
  } catch {}
  return "medium";
}

export const useAssistant = create<AssistantState>((set, get) => ({
  available: null,
  effort: typeof window === "undefined" ? "medium" : savedEffort(),
  setEffort: (effort) => {
    set({ effort });
    try {
      localStorage.setItem(EFFORT_KEY, effort);
    } catch {}
  },
  applied: {},
  messages: [],
  streaming: false,
  projectId: null,

  checkAvailability: async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/assistant/status`);
      const body = (await res.json()) as { available?: boolean };
      set({ available: res.ok && !!body.available });
    } catch {
      set({ available: false });
    }
  },

  ask: async (question, display) => {
    const text = question.trim();
    const context = buildContext();
    if (!text || !context || get().streaming) return;
    const projectId = useWorkspace.getState().project!.id;
    const earlier = get().projectId === projectId ? get().messages : [];
    const answerId = nextId();
    set({
      projectId,
      streaming: true,
      messages: [...earlier, { id: nextId(), role: "user", text, ...(display ? { display } : {}) }, { id: answerId, role: "assistant", text: "", pending: true, startedAt: Date.now(), effort: get().effort }],
    });

    // Earlier turns give follow-up questions their meaning; failed answers are left out.
    const turns: { role: AssistantMessage["role"]; text: string }[] = [...earlier.filter((m) => !m.error && m.text.trim()).slice(-20), { role: "user", text }];
    const history: AssistantMessage[] = turns.map((m) => ({
      role: m.role,
      text: m.text.slice(0, 7_900),
    }));
    const update = (patch: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) =>
      set((s) => ({ messages: s.messages.map((m) => (m.id === answerId ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)) }));

    controller = new AbortController();
    try {
      const res = await fetch(`${API_URL}/api/v1/assistant/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history, context, effort: get().effort }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let message = res.status === 429 ? "The assistant is busy right now. Please try again in a minute." : "The assistant is temporarily unavailable. Please try again.";
        try {
          const body = (await res.json()) as { message?: string | string[] };
          if (body.message) message = Array.isArray(body.message) ? body.message.join(" ") : body.message;
        } catch {}
        update({ pending: false, error: message });
        return;
      }
      let finished = false;
      for await (const event of events(res.body)) {
        if (event.type === "thinking") update((m) => ({ thinking: (m.thinking ?? "") + event.text }));
        else if (event.type === "text") update((m) => ({ text: m.text + event.text, thoughtMs: m.thoughtMs ?? Date.now() - (m.startedAt ?? Date.now()) }));
        else if (event.type === "error") {
          update({ error: event.message });
          finished = true;
        } else finished = true;
      }
      if (!finished) update({ error: "The answer was interrupted. Please try again." });
    } catch (e) {
      if (controller?.signal.aborted) update((m) => ({ error: m.text ? undefined : "Stopped." }));
      else update({ error: e instanceof TypeError ? "Can't reach the server. Check your connection and try again." : "Something went wrong. Please try again." });
    } finally {
      update({ pending: false });
      controller = null;
      set({ streaming: false });
    }
  },

  retry: () => {
    const msgs = get().messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    if (!lastUser || get().streaming) return;
    // Drop the failed exchange and ask again.
    set({ messages: msgs.slice(0, msgs.lastIndexOf(lastUser)) });
    void get().ask(lastUser.text, lastUser.display);
  },

  stop: () => controller?.abort(),

  clear: () => {
    controller?.abort();
    set({ messages: [], streaming: false, applied: {} });
  },

  applyEdit: async (key, block) => {
    const ws = useWorkspace.getState();
    if (!ws.project) return "Open a project first.";
    const path = editTarget(block.file);
    const before = path ? (ws.project.files.find((f) => f.path === path)?.content ?? null) : null;
    const result = resolveEdit(before, { ...block, file: path ?? block.file });
    if (!result.ok) return `Can't apply: ${result.reason}.`;
    let target = path;
    if (result.created) {
      const parts = block.file.split("/");
      const name = parts.pop()!;
      let dir = "";
      for (const part of parts) {
        const next = dir ? `${dir}/${part}` : part;
        if (!ws.project.files.some((f) => f.path.startsWith(`${next}/`))) ws.createFolder(dir, part);
        dir = next;
      }
      target = ws.createFile(dir, name);
      if (!target) return `Can't create ${block.file}.`;
    }
    await writeFile(target!, result.content);
    set((s) => ({ applied: { ...s.applied, [key]: { file: target!, before, after: result.content, hunks: result.hunks } } }));
    return null;
  },

  undoEdit: async (key) => {
    const edit = get().applied[key];
    if (!edit) return null;
    const current = useWorkspace.getState().project?.files.find((f) => f.path === edit.file)?.content;
    if (current !== edit.after) return "The file has changed since; undo it in the editor with Ctrl+Z.";
    if (edit.before === null) useWorkspace.getState().deletePath(edit.file);
    else await writeFile(edit.file, edit.before);
    set((s) => {
      const applied = { ...s.applied };
      delete applied[key];
      return { applied };
    });
    return null;
  },
}));
