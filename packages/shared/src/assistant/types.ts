/**
 * AI assistant. The browser sends the conversation plus the context the user
 * can see (project files, the last run, the visualizer step); the API adds the
 * instructions and calls the model server-side, so the model key never
 * reaches the browser. Answers stream back as server-sent events.
 */

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AssistantFile {
  path: string;
  content: string;
}

/** The last run the user made, as the IDE shows it. */
export interface AssistantRun {
  mode: "run" | "debug" | "visualize";
  /** Final status, e.g. SUCCESS, COMPILATION_ERROR, RUNTIME_ERROR, TIME_LIMIT. */
  status: string;
  /** The IDE's one-line explanation of the result, if any. */
  message?: string;
  exitCode?: number | null;
  /** Everything the program printed (tail kept when long). */
  stdout: string;
  stderr: string;
  /** What the user typed or supplied as input. */
  stdin?: string;
  /** Entry file or class that ran. */
  entry?: string;
}

/** The visualizer step the user is looking at: recorded state, not a guess. */
export interface AssistantStep {
  step: number;
  total: number;
  file: string;
  line: number;
  event: string;
  /** The line that ran to reach this step. */
  ranLine?: number;
  /** Narration of what that line changed, e.g. "Swapped arr[0] and arr[1]". */
  happened: string[];
  /** Call stack with each frame's variables, as text. */
  state: string;
  /** Output printed so far. */
  output: string;
}

export interface AssistantContext {
  language: string;
  files: AssistantFile[];
  /** File open in the editor. */
  activeFile?: string;
  cursorLine?: number;
  selection?: { file: string; startLine: number; endLine: number; text: string };
  lastRun?: AssistantRun;
  visualizer?: AssistantStep;
}

export interface AssistantRequest {
  messages: AssistantMessage[];
  context: AssistantContext;
}

/** Server-sent event payloads of POST /assistant/chat. */
export type AssistantEvent = { type: "text"; text: string } | { type: "done" } | { type: "error"; message: string };

export const ASSISTANT_LIMITS = {
  maxMessages: 30,
  maxMessageChars: 8_000,
  maxFiles: 40,
  /** Everything in the request together (messages, files, output). */
  maxTotalChars: 200_000,
  /** Requests per client per minute and per day. */
  perMinute: 8,
  perDay: 200,
} as const;

export type AssistantValidation = { ok: true; value: AssistantRequest } | { ok: false; error: string };

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optString = (v: unknown, max: number) => v === undefined || isString(v, max);
const optInt = (v: unknown) => v === undefined || v === null || (typeof v === "number" && Number.isInteger(v));

/** Structural validation of an untrusted assistant request. */
export function validateAssistantRequest(input: unknown): AssistantValidation {
  const fail = (error: string): AssistantValidation => ({ ok: false, error });
  if (!isObject(input)) return fail("Request body must be an object.");
  const { messages, context } = input;

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > ASSISTANT_LIMITS.maxMessages) {
    return fail(`Send between 1 and ${ASSISTANT_LIMITS.maxMessages} messages.`);
  }
  for (const m of messages) {
    if (!isObject(m) || (m.role !== "user" && m.role !== "assistant") || !isString(m.text, ASSISTANT_LIMITS.maxMessageChars) || !m.text.trim()) {
      return fail(`Each message needs a role and text of at most ${ASSISTANT_LIMITS.maxMessageChars} characters.`);
    }
  }
  if (messages[messages.length - 1]!.role !== "user") return fail("The last message must be from the user.");

  if (!isObject(context) || !isString(context.language, 32)) return fail("context.language is required.");
  const files = context.files;
  if (!Array.isArray(files) || files.length > ASSISTANT_LIMITS.maxFiles) return fail(`Send at most ${ASSISTANT_LIMITS.maxFiles} files.`);
  for (const f of files) {
    if (!isObject(f) || !isString(f.path, 256) || !isString(f.content, ASSISTANT_LIMITS.maxTotalChars)) return fail("Each file needs a path and content.");
  }
  if (!optString(context.activeFile, 256) || !optInt(context.cursorLine)) return fail("Invalid editor position.");

  const sel = context.selection;
  if (sel !== undefined && (!isObject(sel) || !isString(sel.file, 256) || !isString(sel.text, ASSISTANT_LIMITS.maxMessageChars) || !optInt(sel.startLine) || !optInt(sel.endLine))) {
    return fail("Invalid selection.");
  }
  const run = context.lastRun;
  if (
    run !== undefined &&
    (!isObject(run) ||
      !["run", "debug", "visualize"].includes(run.mode as string) ||
      !isString(run.status, 40) ||
      !isString(run.stdout, 20_000) ||
      !isString(run.stderr, 20_000) ||
      !optString(run.message, 1_000) ||
      !optString(run.stdin, 5_000) ||
      !optString(run.entry, 256) ||
      !optInt(run.exitCode))
  ) {
    return fail("Invalid run details.");
  }
  const viz = context.visualizer;
  if (
    viz !== undefined &&
    (!isObject(viz) ||
      !optInt(viz.step) ||
      !optInt(viz.total) ||
      !optInt(viz.line) ||
      !optInt(viz.ranLine) ||
      !isString(viz.file, 256) ||
      !isString(viz.event, 20) ||
      !Array.isArray(viz.happened) ||
      !viz.happened.every((h) => isString(h, 500)) ||
      !isString(viz.state, 20_000) ||
      !isString(viz.output, 10_000))
  ) {
    return fail("Invalid visualizer step.");
  }

  const total =
    messages.reduce((n, m) => n + (m as AssistantMessage).text.length, 0) +
    files.reduce((n, f) => n + (f as AssistantFile).content.length, 0) +
    (run ? (run.stdout as string).length + (run.stderr as string).length : 0) +
    (viz ? (viz.state as string).length + (viz.output as string).length : 0);
  if (total > ASSISTANT_LIMITS.maxTotalChars) return fail("The project is too large to send to the assistant. Close some files or ask about a smaller part.");

  return { ok: true, value: input as unknown as AssistantRequest };
}
