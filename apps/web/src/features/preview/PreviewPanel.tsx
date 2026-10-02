"use client";

import { ChevronDown, ChevronUp, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/ui/button";
import { FileIcon } from "@/features/explorer/file-icon";
import { useWorkspace } from "@/features/projects/store";
import { cn } from "@/lib/cn";
import { buildPreview, linkedPage, pagesOf } from "./build";
import { usePreview } from "./store";

interface Line {
  level: "log" | "info" | "warn" | "error";
  text: string;
  /** How many times in a row it was logged. */
  count: number;
}

const MAX_LINES = 500;
/** While typing, the page is shown again this long after the last keystroke. */
const TYPING_PAUSE_MS = 500;

/** Tells one page's text from another's (not a secure hash: it only names the frame). */
function checksum(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

/**
 * A web project, running: the page in a frame, and under it what the page
 * logs. The frame is sandboxed with an origin of its own, so the page's
 * scripts can reach nothing of this site (no saved projects, no requests as
 * the visitor). The page is rebuilt as the code changes and on Run.
 */
export function PreviewPanel() {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const runs = usePreview((s) => s.runs);
  const followed = usePreview((s) => s.page);
  const frame = useRef<HTMLIFrameElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(true);

  const files = project?.files;
  const pages = useMemo(() => (files ? pagesOf(files) : []), [files]);
  // The page a link led to; else the HTML file in the editor; else the project's first page.
  const page = (followed && pages.includes(followed) ? followed : undefined) ?? (activeFile && pages.includes(activeFile) ? activeFile : undefined) ?? (project && pages.includes(project.entryFile) ? project.entryFile : pages[0]);
  const html = useMemo(() => (files && page ? buildPreview(files, page) : ""), [files, page]);
  // While typing, the page shown is the one from the last pause.
  const [shown, setShown] = useState(html);
  useEffect(() => {
    const timer = setTimeout(() => setShown(html), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [html]);
  // A new frame for every run, page and change: it loads, says it is ready, and is sent the page.
  const load = useMemo(() => `${runs}:${page}:${checksum(shown)}`, [runs, page, shown]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const data = e.data as { cw?: string; level?: string; text?: unknown; href?: unknown };
      if (data.cw === "ready") {
        setLines([]);
        frame.current?.contentWindow?.postMessage({ cw: "render", html: shown }, "*");
      } else if (data.cw === "console" && typeof data.text === "string") {
        const level = data.level === "error" || data.level === "warn" || data.level === "info" ? data.level : "log";
        const text = data.text.slice(0, 4000);
        setLines((all) => {
          const last = all[all.length - 1];
          if (last && last.level === level && last.text === text) return [...all.slice(0, -1), { ...last, count: last.count + 1 }];
          return [...all.slice(-(MAX_LINES - 1)), { level, text, count: 1 }];
        });
      } else if (data.cw === "navigate" && typeof data.href === "string" && files && page) {
        const to = linkedPage(files, page, data.href);
        if (to) usePreview.getState().setPage(to);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [files, page, shown]);

  if (!project) return null;
  if (!page) return <p className="p-4 text-sm text-fg-subtle">Add an HTML file (for example index.html) to see the page here.</p>;
  const errors = lines.filter((l) => l.level === "error").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <IconButton label="Reload the page" size="sm" onClick={() => usePreview.getState().run()}>
          <RotateCw />
        </IconButton>
        {pages.length > 1 ? (
          <label className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
            <FileIcon name={page} />
            <select aria-label="Page" value={page} onChange={(e) => usePreview.getState().setPage(e.target.value)} className="min-w-0 max-w-56 truncate rounded bg-transparent py-0.5 pr-1 text-sm text-fg outline-none hover:bg-hover">
              {pages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
            <FileIcon name={page} />
            <span className="truncate">{page}</span>
          </span>
        )}
        <span className="ml-auto truncate text-xs text-fg-subtle">Updates as you type</span>
      </div>
      {/* The page is someone's own: always on white, as a browser would show it. */}
      <iframe
        key={load}
        ref={frame}
        title="Page preview"
        src="/preview.html"
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
      <div className={cn("flex shrink-0 flex-col border-t border-line", consoleOpen && lines.length > 0 ? "h-[34%] min-h-24" : "")}>
        <div className="flex h-7 shrink-0 items-center gap-2 px-2 text-xs text-fg-subtle">
          <button type="button" aria-expanded={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)} className="flex items-center gap-1 rounded px-1 py-0.5 font-medium text-fg-muted hover:bg-hover hover:text-fg">
            {consoleOpen ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
            Console
          </button>
          <span>
            {lines.length === 0 ? "Nothing logged" : `${lines.length} message${lines.length === 1 ? "" : "s"}`}
            {errors > 0 && <span className="ml-1.5 text-danger">{`${errors} error${errors === 1 ? "" : "s"}`}</span>}
          </span>
          {lines.length > 0 && (
            <IconButton label="Clear the console" size="sm" className="ml-auto" onClick={() => setLines([])}>
              <Trash2 />
            </IconButton>
          )}
        </div>
        {consoleOpen && lines.length > 0 && (
          <ol role="log" aria-label="Page console" className="cw-console min-h-0 flex-1 overflow-y-auto border-t border-line bg-surface-2 py-1 font-mono text-[12.5px] leading-[19px]">
            {lines.map((l, i) => (
              <li key={i} className={cn("flex gap-2 whitespace-pre-wrap break-words px-3", l.level === "error" ? "bg-danger-soft text-danger" : l.level === "warn" ? "bg-warning-soft text-warning" : "text-fg")}>
                <span className="min-w-0 flex-1">{l.text}</span>
                {l.count > 1 && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] text-fg-muted">{l.count}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
