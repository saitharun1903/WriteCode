"use client";

import { ArrowUp, Check, Copy, CornerDownLeft, RotateCcw, Sparkles, Square, SquarePen, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { editorBridge } from "@/features/editor/bridge";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { useVisualize } from "@/features/visualize/store";
import { cn } from "@/lib/cn";
import { useAssistant, type ChatMessage } from "./store";

const LANG_ALIASES: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", "c++": "cpp", cc: "cpp", h: "c", sh: "shell", bash: "shell" };

/** Removes the indentation every non-blank line shares, so snippets use the panel's width. */
function dedent(code: string): string {
  const lines = code.replace(/\n$/, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(indent) && indent > 0 ? lines.map((l) => l.slice(indent)).join("\n") : lines.join("\n");
}

/** A fenced code block: highlighted with the editor's own colours, with Copy and Insert. */
function CodeBlock({ code: raw, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const language = LANG_ALIASES[lang] ?? lang;
  // Shown and copied without shared indentation; inserted as written, so it fits where it goes.
  const code = dedent(raw);

  useEffect(() => {
    const monaco = editorBridge.monaco;
    if (!monaco || !language) return;
    let live = true;
    // colorize escapes the text itself and returns spans with the theme's token classes.
    monaco.editor
      .colorize(code, language, { tabSize: 4 })
      .then((out: string) => live && setHtml(out))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language]);

  return (
    <div className="group/code my-2 overflow-hidden rounded-md border border-line-strong bg-canvas">
      <div className="flex h-7 items-center justify-between border-b border-line-strong pl-2.5 pr-1 text-[11px] text-fg-subtle">
        <span className="font-mono">{lang || "code"}</span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            className="flex h-5 items-center gap-1 rounded px-1.5 hover:bg-hover hover:text-fg"
            onClick={() => {
              if (editorBridge.insert(raw.replace(/\n$/, ""))) toast.success("Inserted into the editor", "Undo with Ctrl+Z if it isn't what you wanted.");
              else toast.info("Open a file to insert code");
            }}
            title="Insert at the cursor (replaces the selected text)"
          >
            <CornerDownLeft className="size-3" /> Insert
          </button>
          <button
            type="button"
            className="flex h-5 items-center gap-1 rounded px-1.5 hover:bg-hover hover:text-fg"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />} {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-5 text-fg">
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const lang = /language-([\w+#-]+)/.exec(className ?? "")?.[1] ?? "";
    if (lang || text.includes("\n")) return <CodeBlock code={text} lang={lang} />;
    return <code className="rounded bg-hover px-1 py-px font-mono text-[12.5px] text-fg">{children}</code>;
  },
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-3 text-[13px] font-semibold">{children}</h4>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[12.5px] [&_td]:border [&_td]:border-line-strong [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line-strong [&_th]:px-2 [&_th]:py-1">
        {children}
      </table>
    </div>
  ),
};

const Answer = memo(function Answer({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </Markdown>
  );
});

function Message({ message, last }: { message: ChatMessage; last: boolean }) {
  const retry = useAssistant((s) => s.retry);
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-soft px-3 py-2 text-[13px] text-fg">{message.text}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-2.5" aria-busy={message.pending}>
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#6d8cff] to-[#b16cea] text-white">
        <Sparkles className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg">
        {message.text && <Answer text={message.text} />}
        {message.pending && !message.text && (
          <span className="flex items-center gap-1 py-1.5" aria-label="Thinking">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-bounce rounded-full bg-fg-subtle" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </span>
        )}
        {message.pending && message.text && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-accent" />}
        {message.error && (
          <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-danger-soft px-2.5 py-1.5 text-[12.5px] text-danger">
            {message.error}
            {last && (
              <button type="button" onClick={retry} className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-fg hover:bg-hover">
                <RotateCcw className="size-3" /> Try again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface Suggestion {
  label: string;
  prompt: string;
  primary?: boolean;
}

/** Starting points that fit the moment: a failed run, the visualizer, the open file. */
function useSuggestions(): Suggestion[] {
  const activeFile = useWorkspace((s) => s.activeFile);
  const projectId = useWorkspace((s) => s.project?.id);
  const run = useExecution((s) => s.run);
  const vizOpen = useSettings((s) => s.layout.bottomOpen && s.layout.bottomTab === "visualize");
  const hasTrace = useVisualize((s) => !!s.trace);
  const out: Suggestion[] = [];
  const status = run && run.projectId === projectId && !isRunning(run) ? run.result?.status : undefined;
  if (status && status !== "SUCCESS" && status !== "CANCELLED") {
    out.push({ label: "Why did my program fail?", prompt: "My last run didn't work. What went wrong, and how do I fix it?", primary: true });
  }
  if (vizOpen && hasTrace) {
    out.push({ label: "Explain this step", prompt: "Explain what the line that just ran did in the visualizer, using the values shown, and what happens next.", primary: !out.length });
  }
  const file = activeFile ?? "this code";
  out.push({ label: `Explain ${file}`, prompt: `Explain what ${file} does, step by step, in simple words.` });
  out.push({ label: "Find bugs", prompt: `Check ${file} for bugs or edge cases that would crash or give wrong results. Only mention real problems.` });
  out.push({ label: "How can I improve it?", prompt: "How could I make this code clearer or more efficient without changing what it does?" });
  return out;
}

function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  const suggestions = useSuggestions();
  return (
    <div className="flex flex-1 flex-col justify-end gap-4 px-4 pb-4 pt-8">
      <div>
        <div className="mb-3 flex size-10 items-center justify-center rounded-2xl bg-gradient-to-br from-[#6d8cff] to-[#b16cea] text-white shadow-[0_8px_24px_-10px_#8a7cf5]">
          <Sparkles className="size-5" />
        </div>
        <p className="text-[15px] font-semibold text-fg">Hi! Ask me anything about your code.</p>
        <p className="mt-1 text-[13px] text-fg-subtle">I can see your files, your last run and the visualizer, so you don&apos;t need to paste anything.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.prompt)}
            className={cn(
              "rounded-lg border px-3 py-2 text-left text-[13px] transition-colors",
              s.primary ? "border-accent/60 bg-accent-soft/50 text-fg hover:bg-accent-soft" : "border-line-strong text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What will be shared with the next question, so nothing is sent silently. */
function ContextLine() {
  const activeFile = useWorkspace((s) => s.activeFile);
  const fileCount = useWorkspace((s) => s.project?.files.length ?? 0);
  const projectId = useWorkspace((s) => s.project?.id);
  const run = useExecution((s) => s.run);
  const vizOpen = useSettings((s) => s.layout.bottomOpen && s.layout.bottomTab === "visualize");
  const vizStep = useVisualize((s) => (s.trace ? s.step + 1 : null));
  const chips: ReactNode[] = [];
  chips.push(activeFile ? `${activeFile}${fileCount > 1 ? ` +${fileCount - 1}` : ""}` : `${fileCount} files`);
  if (run && run.projectId === projectId && run.status !== "SUBMITTING") chips.push(`last run: ${(run.result?.status ?? run.status).toLowerCase().replace(/_/g, " ")}`);
  if (vizOpen && vizStep) chips.push(`visualizer step ${vizStep}`);
  return (
    <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5 text-[11px] text-fg-subtle" aria-label="Shared with the assistant">
      <span>Sees:</span>
      {chips.map((c, i) => (
        <span key={i} className="rounded bg-hover px-1.5 py-px font-mono">
          {c}
        </span>
      ))}
    </div>
  );
}

/** AI assistant tool window: questions about the open project, answered with its code, last run and visualizer state. */
export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const available = useAssistant((s) => s.available);
  const messages = useAssistant((s) => s.messages);
  const streaming = useAssistant((s) => s.streaming);
  const conversationProject = useAssistant((s) => s.projectId);
  const projectId = useWorkspace((s) => s.project?.id);
  const { ask, stop, clear, checkAvailability } = useAssistant.getState();
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = useMemo(() => (conversationProject === projectId ? messages : []), [conversationProject, projectId, messages]);

  useEffect(() => {
    if (available === null) void checkAvailability();
  }, [available, checkAvailability]);

  // Follow the answer as it streams, unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const send = (text: string) => {
    if (!text.trim() || streaming) return;
    stick.current = true;
    setDraft("");
    void ask(text);
  };

  return (
    <section aria-label="AI Assistant" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5">
        <Sparkles className="size-4 text-[#8a7cf5]" />
        <h2 className="flex-1 truncate text-sm font-semibold text-fg">AI Assistant</h2>
        <IconButton label="New chat" size="sm" disabled={shown.length === 0} onClick={clear}>
          <SquarePen />
        </IconButton>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X />
        </IconButton>
      </div>

      {available === false ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-subtle">
          <Sparkles className="size-6 text-fg-faint" />
          <p>The AI assistant isn&apos;t available on this server right now.</p>
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => void checkAvailability()}>
            Check again
          </button>
        </div>
      ) : (
        <>
          <div
            ref={scroller}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {shown.length === 0 ? (
              <Welcome onPick={send} />
            ) : (
              <div role="log" aria-label="Conversation" className="flex flex-col gap-4 px-3 py-4">
                {shown.map((m, i) => (
                  <Message key={m.id} message={m} last={i === shown.length - 1} />
                ))}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-line pt-2">
            <ContextLine />
            <form
              className="mx-3 mb-2 flex items-end gap-2 rounded-xl border border-line-strong bg-surface-2 p-1.5 pl-3 focus-within:border-accent"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <textarea
                ref={input}
                rows={1}
                value={draft}
                maxLength={7_900}
                aria-label="Ask the assistant"
                placeholder={shown.length ? "Ask a follow-up…" : "Ask about your code…"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
                className="max-h-44 min-h-7 flex-1 resize-none bg-transparent py-1 text-[13px] text-fg outline-none placeholder:text-fg-faint"
              />
              {streaming ? (
                <button type="button" aria-label="Stop" onClick={stop} className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-fg text-canvas">
                  <Square className="size-3 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  aria-label="Send question"
                  disabled={!draft.trim()}
                  className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity disabled:opacity-35"
                >
                  <ArrowUp className="size-4" />
                </button>
              )}
            </form>
            <p className="px-3 pb-2 text-[10.5px] text-fg-faint">Answers come from Google Gemini and can be wrong. Run the code to check.</p>
          </div>
        </>
      )}
    </section>
  );
}
