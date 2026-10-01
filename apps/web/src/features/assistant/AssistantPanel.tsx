"use client";

import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bug,
  Check,
  CircleAlert,
  CircleCheck,
  ChevronRight,
  Copy,
  FileCode2,
  Gauge,
  Lightbulb,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  SquarePen,
  Undo2,
  Workflow,
  Wrench,
  X,
} from "lucide-react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "motion/react";
import { IconButton } from "@/components/ui/button";
import { runCommand } from "@/features/commands/registry";
import { FileIcon } from "@/features/explorer/file-icon";
import { editorBridge } from "@/features/editor/bridge";
import { isRunning, useExecution } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { toast } from "@/components/ui/toast";
import { useSettings } from "@/features/settings/store";
import { useVisualize } from "@/features/visualize/store";
import { cn } from "@/lib/cn";
import { monacoLanguageForPath, type AssistantEffort } from "@cw/shared";
import { parseEditBlock, resolveEdit, type ResolvedHunk } from "./edits";
import { plainMath } from "./plain-math";
import { editTarget, useAssistant, type ChatMessage } from "./store";

const LANG_ALIASES: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", "c++": "cpp", cc: "cpp", h: "c", sh: "shell", bash: "shell" };
/** The assistant's own tiles and its send button: the interface's accent. */
const AI_GRADIENT = "bg-accent";

/** Highlights code with the editor's own colours; one HTML string per line. */
function useColorized(code: string, lang: string): string[] | null {
  const [lines, setLines] = useState<string[] | null>(null);
  const language = LANG_ALIASES[lang] ?? lang;
  useEffect(() => {
    const monaco = editorBridge.monaco;
    if (!monaco || !language) return;
    let live = true;
    // colorize escapes the text itself and returns spans with the theme's token classes.
    monaco.editor
      .colorize(code, language, { tabSize: 4 })
      .then((html: string) => live && setLines(html.split("<br/>")))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language]);
  return lines;
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-fg-subtle hover:bg-hover hover:text-fg"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => toast.error("Could not copy", "The browser did not allow access to the clipboard."),
        )
      }
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}

/** Removes the indentation every non-blank line shares, so snippets use the panel's width. */
function dedent(code: string): string {
  const lines = code.replace(/\n$/, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(indent) && indent > 0 ? lines.map((l) => l.slice(indent)).join("\n") : lines.join("\n");
}

/** An example snippet (not an edit to the user's files): highlighted, with Copy. */
function CodeBlock({ code: raw, lang }: { code: string; lang: string }) {
  const code = dedent(raw);
  const html = useColorized(code, lang);
  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-line-strong bg-canvas">
      <div className="flex h-7 items-center justify-between border-b border-line-strong pl-3 pr-1 text-[11px] text-fg-subtle">
        <span className="font-mono">{lang || "code"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-[12.5px] leading-5 text-fg">
        {html ? html.map((line, i) => <div key={i} dangerouslySetInnerHTML={{ __html: line || " " }} />) : <code>{code}</code>}
      </pre>
    </div>
  );
}

// -- Edits

type DiffLine = { kind: " " | "-" | "+"; text: string; line: number };

/** Line diff of a hunk (removed vs added), so unchanged context lines show as context. */
function diffHunk(h: ResolvedHunk): DiffLine[] {
  const a = h.removed;
  const b = h.added;
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]!, line: h.startLine + j });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      out.push({ kind: "+", text: b[j]!, line: h.startLine + j });
      j++;
    } else {
      out.push({ kind: "-", text: a[i]!, line: h.startLine + i });
      i++;
    }
  }
  return out;
}

function DiffView({ hunks, lang }: { hunks: ResolvedHunk[]; lang: string }) {
  const lines = useMemo(() => hunks.flatMap((h, n) => [...(n > 0 ? [null] : []), ...diffHunk(h)]), [hunks]);
  // Shared indentation is dropped so the change is what stands out.
  const indent = Math.min(...lines.filter((l): l is DiffLine => !!l && !!l.text.trim()).map((l) => /^[ \t]*/.exec(l.text)![0].length));
  const cut = Number.isFinite(indent) ? indent : 0;
  const html = useColorized(lines.map((l) => (l ? l.text.slice(cut) : "")).join("\n"), lang);
  return (
    <pre className="overflow-x-auto py-1.5 font-mono text-[12.5px] leading-5">
      {lines.map((l, i) =>
        l === null ? (
          <div key={i} className="px-3 text-fg-faint">
            ⋯
          </div>
        ) : (
          <div
            key={i}
            className={cn("flex min-w-fit pr-3", l.kind === "-" && "bg-danger-soft", l.kind === "+" && "bg-success-soft")}
          >
            <span className="w-9 shrink-0 select-none pr-1 text-right text-[11px] leading-5 text-fg-faint">{l.kind === "-" ? "" : l.line}</span>
            <span className={cn("w-4 shrink-0 select-none text-center", l.kind === "-" ? "text-danger" : l.kind === "+" ? "text-success" : "text-fg-faint")}>
              {l.kind === " " ? "" : l.kind === "-" ? "−" : "+"}
            </span>
            {html ? (
              <span className={cn("whitespace-pre", l.kind === "-" && "opacity-70 line-through decoration-danger/40")} dangerouslySetInnerHTML={{ __html: html[i] || " " }} />
            ) : (
              <span className={cn("whitespace-pre text-fg", l.kind === "-" && "opacity-70")}>{l.text.slice(cut)}</span>
            )}
          </div>
        ),
      )}
    </pre>
  );
}

const MessageContext = createContext<{ id: string; pending: boolean }>({ id: "", pending: false });

/** A proposed change to the user's files: a diff with Apply, then Undo and Run. */
function EditCard({ body, index }: { body: string; index: number }) {
  const { id, pending } = useContext(MessageContext);
  const key = `${id}:${index}`;
  const block = useMemo(() => parseEditBlock(body), [body]);
  const applied = useAssistant((s) => s.applied[key]);
  const target = block ? editTarget(block.file) : null;
  const content = useWorkspace((s) => (target ? (s.project?.files.find((f) => f.path === target)?.content ?? null) : null));
  const language = useWorkspace((s) => s.project?.language ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!block || !block.complete) {
    return (
      <div className="my-2.5 flex items-center gap-2 rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-[12.5px]">
        <Wrench className="size-3.5 text-accent-ink" />
        <span className={pending ? "cw-shimmer" : "text-fg-subtle"}>{pending ? "Preparing a fix…" : "This fix was cut off."}</span>
      </div>
    );
  }

  const resolved = applied ? null : resolveEdit(content, { ...block, file: target ?? block.file });
  const hunks = applied ? applied.hunks : resolved?.ok ? resolved.hunks : null;
  // Coloured as the file's own language, whichever it is; the project's language when the name does not say.
  const known = monacoLanguageForPath(block.file);
  const lang = known === "plaintext" ? language : known;
  const lineLabel = hunks
    ? hunks.length === 1
      ? hunks[0]!.added.length > 1
        ? `lines ${hunks[0]!.startLine}–${hunks[0]!.startLine + hunks[0]!.added.length - 1}`
        : `line ${hunks[0]!.startLine}`
      : `${hunks.length} changes`
    : "";

  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(await fn());
    setBusy(false);
  };

  return (
    <div
      role="group"
      aria-label={`Suggested change to ${target ?? block.file}`}
      className={cn("my-3 overflow-hidden rounded-xl border bg-canvas shadow-sm transition-colors", applied ? "border-success/50" : "border-line-strong")}
    >
      <div className="flex h-8 items-center gap-2 border-b border-line-strong bg-surface-2/60 px-3">
        <FileCode2 className="size-3.5 shrink-0 text-fg-subtle" />
        <span className="min-w-0 truncate font-mono text-[12px] text-fg">{target ?? block.file}</span>
        {lineLabel && <span className="shrink-0 text-[11px] text-fg-subtle">· {lineLabel}</span>}
        {applied && (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-success">
            <Check className="size-3.5" /> Applied
          </span>
        )}
      </div>
      {hunks ? (
        <DiffView hunks={hunks} lang={lang} />
      ) : (
        <>
          <p className="border-b border-line-strong bg-warning-soft px-3 py-1.5 text-[11.5px] text-warning">
            Can&apos;t apply automatically: {resolved && !resolved.ok ? resolved.reason : "unknown file"}. Here is the suggested code to copy.
          </p>
          <CodeBlock code={block.hunks.map((h) => h.updated.join("\n")).join("\n\n")} lang={lang} />
        </>
      )}
      <div className="flex items-center justify-end gap-1 border-t border-line-strong px-2 py-1.5">
        {problem && <span className="mr-auto pl-1 text-[11.5px] text-danger">{problem}</span>}
        {applied ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => useAssistant.getState().undoEdit(key))}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
            >
              <Undo2 className="size-3.5" /> Undo
            </button>
            <button
              type="button"
              onClick={() => runCommand("run.execute")}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-success px-3 text-[12px] font-medium text-white shadow-sm hover:brightness-110"
            >
              <Play className="size-3 fill-current" /> Run again
            </button>
          </>
        ) : resolved?.ok ? (
          <>
            <CopyButton text={block.hunks.map((h) => h.updated.join("\n")).join("\n\n")} />
            <button
              type="button"
              disabled={busy || pending}
              onClick={() => void act(() => useAssistant.getState().applyEdit(key, block))}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-accent-fg shadow-sm hover:brightness-110 disabled:opacity-50"
            >
              <Check className="size-3.5" /> {resolved.created ? "Create file" : "Apply fix"}
            </button>
          </>
        ) : (
          <CopyButton text={block.hunks.map((h) => h.updated.join("\n")).join("\n\n")} />
        )}
      </div>
    </div>
  );
}

// -- Answers

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, node }) => {
    const text = String(children ?? "");
    const lang = /language-([\w+#-]+)/.exec(className ?? "")?.[1] ?? "";
    if (lang === "edit") return <EditCard body={text} index={node?.position?.start.offset ?? 0} />;
    if (lang || text.includes("\n")) return <CodeBlock code={text} lang={lang} />;
    return <code className="rounded-[4px] bg-hover px-1 py-px font-mono text-[12.5px] text-fg">{children}</code>;
  },
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-fg-faint">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-fg-subtle">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  h1: ({ children }) => <h3 className="mb-1 mt-3 text-[13.5px] font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-3 text-[13.5px] font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-3 text-[13px] font-semibold">{children}</h4>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2.5 overflow-x-auto rounded-lg border border-line-strong">
      {/* Short columns (numbers) stay on one line; the widest text column wraps at a readable width. */}
      <table className="w-max min-w-full border-collapse text-[12px] leading-snug [&_td]:max-w-[15rem] [&_td]:border-t [&_td]:border-line-strong [&_td]:px-2.5 [&_td]:py-1 [&_td]:align-top [&_th]:whitespace-nowrap [&_th]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-fg-muted [&_td:last-child]:min-w-[10rem]">
        {children}
      </table>
    </div>
  ),
};

const Answer = memo(function Answer({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {plainMath(text)}
    </Markdown>
  );
});

/**
 * Reveals streamed text at a steady pace instead of in the bursts the network
 * delivers, speeding up when it falls behind, so answers read naturally.
 */
function useSmoothText(target: string, live: boolean): string {
  const [shown, setShown] = useState(live ? "" : target);
  const current = useRef(shown);
  useEffect(() => {
    if (!live && current.current === target) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last >= 24) {
        last = t;
        const remaining = target.length - current.current.length;
        if (remaining <= 0 || !target.startsWith(current.current)) {
          current.current = target;
          setShown(target);
          return;
        }
        const step = Math.max(3, Math.ceil(remaining / 14));
        current.current = target.slice(0, current.current.length + step);
        setShown(current.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, live]);
  return shown;
}

/** The latest reasoning headline, e.g. "Analyzing the loop bounds". */
function thinkingHeadline(thinking: string | undefined): string {
  if (!thinking) return "";
  const titles = [...thinking.matchAll(/\*\*([^*\n]{3,80})\*\*/g)].map((m) => m[1]!.trim());
  return titles.pop() ?? "";
}

function Thinking({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const thinking = message.thinking?.trim();
  const answering = !!message.text;
  if (!answering && message.pending) {
    const headline = thinkingHeadline(thinking);
    return (
      <div className="flex flex-col gap-1 py-0.5" aria-label="Thinking">
        <span className="cw-shimmer text-[13px] font-medium">Thinking…</span>
        {headline && <span className="text-[12px] text-fg-subtle">{headline}</span>}
      </div>
    );
  }
  if (!message.thoughtMs) return null;
  if (!thinking) {
    return (
      <p className="mb-1.5 text-[12px] text-fg-subtle">
        Answered in {Math.max(1, Math.round(message.thoughtMs / 1000))}s{message.effort && message.effort !== "medium" ? ` · ${message.effort === "high" ? "High" : "Low"} effort` : ""}
      </p>
    );
  }
  return (
    <div className="mb-1.5">
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[12px] text-fg-subtle hover:text-fg" aria-expanded={open}>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Thought for {Math.max(1, Math.round(message.thoughtMs / 1000))}s{message.effort && message.effort !== "medium" ? ` · ${message.effort === "high" ? "High" : "Low"} effort` : ""}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l-2 border-line-strong pl-3 text-[12px] leading-relaxed text-fg-subtle">{thinking.replace(/\*\*/g, "")}</div>}
    </div>
  );
}

function Message({ message, last }: { message: ChatMessage; last: boolean }) {
  const retry = useAssistant((s) => s.retry);
  const streaming = useAssistant((s) => s.streaming);
  const text = useSmoothText(message.text, !!message.pending);
  const context = useMemo(() => ({ id: message.id, pending: !!message.pending }), [message.id, message.pending]);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-[18px] rounded-br-md bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface-2))] px-3.5 py-2 text-[13.5px] leading-relaxed text-fg">{message.display ?? message.text}</div>
      </div>
    );
  }
  // Actions appear once the answer is complete and fully revealed on screen.
  const done = !message.pending && !!message.text && text.length >= message.text.length;
  return (
    <div className="group flex gap-3" aria-busy={message.pending}>
      <div className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-accent-fg", AI_GRADIENT)}>
        <Sparkles className={cn("size-3.5", message.pending && !message.text && "animate-pulse")} />
      </div>
      <div className="min-w-0 flex-1 text-[13.5px] leading-[1.65] text-fg">
        <Thinking message={message} />
        {text && (
          <MessageContext.Provider value={context}>
            <Answer text={text} />
          </MessageContext.Provider>
        )}
        {message.error && (
          <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
            {message.error}
            {last && (
              <button type="button" onClick={retry} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-fg hover:bg-hover">
                <RotateCcw className="size-3" /> Try again
              </button>
            )}
          </div>
        )}
        {done && (
          <div className={cn("mt-1.5 flex items-center gap-0.5 transition-opacity", last ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
            <CopyButton text={message.text} />
            {last && !streaming && (
              <button type="button" onClick={retry} className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-fg-subtle hover:bg-hover hover:text-fg">
                <RotateCcw className="size-3.5" /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Starting points

interface Suggestion {
  icon: ReactNode;
  /** Icon tile colour. */
  tint: string;
  label: string;
  hint: string;
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
    out.push({ icon: <Wrench />, tint: "", label: "Fix my program", hint: "Find what went wrong in the last run and fix it", prompt: "My last run didn't work. What went wrong? Fix it.", primary: true });
  }
  if (vizOpen && hasTrace) {
    out.push({ icon: <Workflow />, tint: "", label: "Explain this step", hint: "What the line that just ran did", prompt: "Explain what the line that just ran did in the visualizer, using the values shown, and what happens next.", primary: !out.length });
  }
  const file = activeFile ?? "this code";
  out.push({ icon: <BookOpen />, tint: "bg-[#5b8def]/12 text-[#5b8def]", label: `Explain ${file}`, hint: "Step by step, with real values", prompt: `Explain what ${file} does, step by step, in simple words.` });
  out.push({ icon: <Bug />, tint: "bg-[#e5576d]/12 text-[#e5576d]", label: "Find bugs", hint: "Only real problems, with fixes", prompt: `Check ${file} for bugs or edge cases that would crash or give wrong results. Only mention real problems.` });
  out.push({ icon: <Lightbulb />, tint: "bg-[#e0a526]/14 text-[#d09514]", label: "Improve it", hint: "Clearer or faster, same behaviour", prompt: "How could I make this code clearer or more efficient without changing what it does?" });
  return out;
}

/** Enters once, a few pixels up, one item after another. */
const rise = (i: number) => ({
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.28, delay: 0.04 * i, ease: [0.2, 0.8, 0.2, 1] as const },
});

function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  const suggestions = useSuggestions();
  const primary = suggestions.filter((s) => s.primary);
  const rest = suggestions.filter((s) => !s.primary);
  return (
    <div className="relative flex flex-1 flex-col justify-end overflow-hidden px-4 pb-5 pt-10">
      <motion.div {...rise(0)} className="relative">
        <div className={cn("relative mb-4 flex size-12 items-center justify-center rounded-[15px] text-accent-fg", AI_GRADIENT)}>
          <span aria-hidden className="absolute inset-0 rounded-[15px] ring-1 ring-inset ring-white/25" />
                    <Sparkles className="relative size-[22px]" />
        </div>
        <h3 className="text-[19px] font-semibold tracking-[-0.01em] text-fg">
          How can I <span className="underline decoration-accent decoration-[3px] underline-offset-4">help</span> with your code?
        </h3>
      </motion.div>

      <div className="relative mt-5 flex flex-col gap-2.5">
        {primary.map((s, i) => (
          <motion.button
            {...rise(i + 1)}
            key={s.label}
            type="button"
            onClick={() => onPick(s.prompt)}
            className="group relative rounded-2xl bg-line-strong p-px hover:bg-accent text-left"
          >
            <span className="flex items-center gap-3 rounded-[15px] bg-surface-2 px-3.5 py-3 transition-colors group-hover:bg-[color-mix(in_srgb,var(--surface-2)_90%,var(--accent))]">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px] text-white [&_svg]:size-4", AI_GRADIENT)}>{s.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-fg">{s.label}</span>
                <span className="block truncate text-[12px] text-fg-subtle">{s.hint}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-accent-ink transition-transform group-hover:translate-x-0.5" />
            </span>
          </motion.button>
        ))}
        <motion.div {...rise(primary.length + 1)} className="overflow-hidden rounded-2xl border border-line-strong/70 bg-surface-2/70 backdrop-blur-sm">
          {rest.map((s, i) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.prompt)}
              className={cn("group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/70", i > 0 && "border-t border-line-strong/50")}
            >
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-4", s.tint)}>{s.icon}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{s.label}</span>
              <ArrowRight className="size-4 shrink-0 -translate-x-1 text-fg-faint opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
            </button>
          ))}
        </motion.div>
      </div>
    </div>
  );
}

/** What will be shared with the next question, so nothing is sent silently. Shown as chips inside the composer. */
function ContextChips() {
  const activeFile = useWorkspace((s) => s.activeFile);
  const fileCount = useWorkspace((s) => s.project?.files.length ?? 0);
  const projectId = useWorkspace((s) => s.project?.id);
  const run = useExecution((s) => s.run);
  const vizOpen = useSettings((s) => s.layout.bottomOpen && s.layout.bottomTab === "visualize");
  const vizStep = useVisualize((s) => (s.trace ? s.step + 1 : null));
  const status = run && run.projectId === projectId && run.status !== "SUBMITTING" ? (run.result?.status ?? run.status) : null;
  const failed = !!status && status !== "SUCCESS" && status !== "CANCELLED" && !isRunning(run);
  const chip = "flex h-6 max-w-full items-center gap-1.5 rounded-lg bg-hover/80 px-2 text-[11.5px] text-fg-muted";
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2.5" aria-label="Shared with the assistant">
      <span className={chip}>
        {activeFile ? <FileIcon name={activeFile} /> : <FileCode2 className="size-3.5" />}
        <span className="truncate">{activeFile ?? `${fileCount} files`}</span>
        {activeFile && fileCount > 1 && <span className="text-fg-subtle">+{fileCount - 1}</span>}
      </span>
      {status && (
        <span className={chip}>
          {failed ? <CircleAlert className="size-3.5 text-danger" /> : <CircleCheck className="size-3.5 text-success" />}
          <span>last run: {status.toLowerCase().replace(/_/g, " ")}</span>
        </span>
      )}
      {vizOpen && vizStep && (
        <span className={chip}>
          <Workflow className="size-3.5 text-accent-ink" />
          visualizer step {vizStep}
        </span>
      )}
    </div>
  );
}

// -- Effort

const EFFORTS: { id: AssistantEffort; label: string; about: string }[] = [
  { id: "low", label: "Low", about: "Fastest answers, usually within a few seconds. Good for quick questions and simple errors." },
  { id: "medium", label: "Medium", about: "Balanced. Answers quickly, and thinks harder on its own for reviews and bug hunts." },
  { id: "high", label: "High", about: "Reasons longest and double-checks its work. Best for tricky bugs; can take 10–30 seconds." },
];

/** Faster to smarter: how hard the assistant thinks before answering. */
function EffortControl() {
  const effort = useAssistant((s) => s.effort);
  const setEffort = useAssistant((s) => s.setEffort);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const index = EFFORTS.findIndex((e) => e.id === effort);
  const current = EFFORTS[index]!;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Effort: ${current.label}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
          open ? "border-accent/70 bg-accent/10 text-fg" : "border-line-strong text-fg-muted hover:border-fg-faint hover:text-fg",
        )}
      >
        <Gauge className="size-3.5 text-accent-ink" />
        <span className="text-fg-subtle">Effort</span>
        <span className="font-medium text-fg">{current.label}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Reasoning effort"
          className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-2xl border border-line-strong bg-overlay p-4 shadow-float animate-fade"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] text-fg-subtle">Effort</span>
            <span className="text-[14px] font-semibold text-fg">{current.label}</span>
          </div>
          <div className="mt-3 flex justify-between text-[12px] text-fg-subtle">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <div className="relative mt-2 h-8">
            {/* Track with a dot per level; the native range input on top keeps keyboard and screen readers working. */}
            <div className="absolute inset-x-0 top-1/2 h-6 -translate-y-1/2 rounded-full bg-hover">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent/40 to-accent/40 transition-[width] duration-200"
                style={{ width: `calc(24px + (100% - 24px) * ${index / (EFFORTS.length - 1)})` }}
              />
              {EFFORTS.map((e, i) => (
                <span
                  key={e.id}
                  className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-faint"
                  style={{ left: `calc(12px + (100% - 24px) * ${i / (EFFORTS.length - 1)})` }}
                />
              ))}
              <span
                className="absolute top-1/2 h-7 w-6 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white shadow-md ring-1 ring-black/10 transition-[left] duration-200"
                style={{ left: `calc(12px + (100% - 24px) * ${index / (EFFORTS.length - 1)})` }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={EFFORTS.length - 1}
              step={1}
              value={index}
              aria-label="Reasoning effort"
              aria-valuetext={current.label}
              onChange={(e) => setEffort(EFFORTS[Number(e.target.value)]!.id)}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </div>
          <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">{current.about}</p>
        </div>
      )}
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
    if (!el) return;
    const follow = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [shown]);

  // Grow with the text up to a limit; re-measure when the panel's width changes.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [draft]);

  const send = (text: string) => {
    if (!text.trim() || streaming) return;
    stick.current = true;
    setDraft("");
    void ask(text);
  };

  return (
    <section aria-label="AI Assistant" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3.5 pr-1.5">
        <span className={cn("flex size-5 items-center justify-center rounded-md text-accent-fg", AI_GRADIENT)}>
          <Sparkles className="size-3" />
        </span>
        <h2 className="flex-1 truncate text-[13.5px] font-semibold text-fg">AI Assistant</h2>
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
          <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => void checkAvailability()}>
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
              <div role="log" aria-label="Conversation" className="flex flex-col gap-5 px-3.5 py-4">
                {shown.map((m, i) => (
                  <Message key={m.id} message={m} last={i === shown.length - 1} />
                ))}
              </div>
            )}
          </div>

          <div className="shrink-0 px-3 pb-3 pt-1">
            {/* A hairline border that turns into the assistant's gradient while typing. */}
            <div className="rounded-[18px] bg-line-strong/80 p-px shadow-[0_8px_24px_-16px_rgb(0_0_0/0.35)] focus-within:bg-accent">
            <form
              className="flex flex-col rounded-[17px] bg-surface-2"
              onSubmit={(e) => {
                e.preventDefault();
                send(draft);
              }}
            >
              <ContextChips />
              <textarea
                ref={input}
                rows={1}
                value={draft}
                maxLength={7_900}
                aria-label="Ask the assistant"
                placeholder={shown.length ? "Ask a follow-up…" : "Ask anything about your code…"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(draft);
                  }
                }}
                className="max-h-40 min-h-10 resize-none bg-transparent px-3.5 pb-1 pt-2 text-[13.5px] leading-5 text-fg outline-none placeholder:text-fg-faint"
              />
              <div className="flex items-center justify-between gap-2 px-2 pb-2">
                <EffortControl />
                {streaming ? (
                  <button type="button" aria-label="Stop" onClick={stop} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-fg text-canvas transition-transform hover:scale-105 active:scale-95">
                    <Square className="size-2.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    aria-label="Send question"
                    disabled={!draft.trim()}
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full transition-all active:scale-95",
                      draft.trim() ? cn("text-accent-fg hover:brightness-110", AI_GRADIENT) : "bg-hover text-fg-faint",
                    )}
                  >
                    <ArrowUp className="size-4" />
                  </button>
                )}
              </div>
            </form>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
