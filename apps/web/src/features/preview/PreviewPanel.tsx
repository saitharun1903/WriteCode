"use client";

import { ArrowLeft, Maximize2, Minimize2, RotateCw, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

function BarButton({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-[18px]",
        active && "bg-active text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A web project, running, in a browser of its own: a bar with the page's
 * title and address, and the page under it. `full` fills the window, the way
 * a link opens inside an app; otherwise it stands beside the code. The frame
 * is sandboxed with an origin of its own, so the page's scripts can reach
 * nothing of this site. The page follows the code as it is typed.
 */
export function PreviewPanel({ full }: { full: boolean }) {
  const project = useWorkspace((s) => s.project);
  const activeFile = useWorkspace((s) => s.activeFile);
  const runs = usePreview((s) => s.runs);
  const trail = usePreview((s) => s.trail);
  const frame = useRef<HTMLIFrameElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [title, setTitle] = useState("");

  const files = project?.files;
  const pages = useMemo(() => (files ? pagesOf(files) : []), [files]);
  // The page a link led to; else the HTML file in the editor; else the project's first page.
  const followed = trail[trail.length - 1];
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
        setTitle("");
        frame.current?.contentWindow?.postMessage({ cw: "render", html: shown }, "*");
      } else if (data.cw === "title" && typeof data.text === "string") setTitle(data.text.slice(0, 120));
      else if (data.cw === "console" && typeof data.text === "string") {
        const level = data.level === "error" || data.level === "warn" || data.level === "info" ? data.level : "log";
        const text = data.text.slice(0, 4000);
        setLines((all) => {
          const last = all[all.length - 1];
          if (last && last.level === level && last.text === text) return [...all.slice(0, -1), { ...last, count: last.count + 1 }];
          return [...all.slice(-(MAX_LINES - 1)), { level, text, count: 1 }];
        });
      } else if (data.cw === "navigate" && typeof data.href === "string" && files && page) {
        const to = linkedPage(files, page, data.href);
        if (to) usePreview.getState().go(to);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [files, page, shown]);

  // Escape leaves the full window.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && usePreview.getState().setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  if (!project) return null;
  const errors = lines.filter((l) => l.level === "error").length;
  const { reload, back, close, setFull } = usePreview.getState();

  return (
    <section aria-label="Preview" className={cn("flex min-h-0 flex-col bg-canvas", full ? "fixed inset-0 z-50 pt-[env(safe-area-inset-top)]" : "h-full")}>
      {/* The bar of a browser inside an app: back, what the page is, and the few things to do with it. */}
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        {trail.length > 0 ? (
          <BarButton label="Back" onClick={back}>
            <ArrowLeft />
          </BarButton>
        ) : (
          <BarButton label="Close the preview" onClick={close}>
            <X />
          </BarButton>
        )}
        <div className="mx-1 flex min-w-0 flex-1 flex-col items-center leading-tight">
          <span className="max-w-full truncate text-[13.5px] font-semibold text-fg">{title || page || project.name}</span>
          {pages.length > 1 ? (
            <select aria-label="Page" value={page} onChange={(e) => usePreview.getState().go(e.target.value)} className="max-w-full truncate rounded bg-transparent text-center text-[11.5px] text-fg-subtle outline-none hover:text-fg">
              {pages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <span className="max-w-full truncate text-[11.5px] text-fg-subtle">{page ?? "no page"}</span>
          )}
        </div>
        <BarButton label="Reload the page" onClick={reload}>
          <RotateCw />
        </BarButton>
        <BarButton label={errors ? `Console: ${errors} error${errors === 1 ? "" : "s"}` : "Console"} active={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>
          <SquareTerminal />
          {lines.length > 0 && <span className={cn("absolute right-1 top-1 size-2 rounded-full ring-2 ring-canvas", errors ? "bg-danger" : "bg-accent")} />}
        </BarButton>
        <span className="max-md:hidden">
          <BarButton label={full ? "Show beside the code" : "Fill the window"} onClick={() => setFull(!full)}>
            {full ? <Minimize2 /> : <Maximize2 />}
          </BarButton>
        </span>
      </div>
      {page ? (
        // The page is someone's own: on white, as a browser would show it.
        <iframe key={load} ref={frame} title="Page preview" src="/preview.html" sandbox="allow-scripts allow-forms allow-modals allow-popups" className="min-h-0 w-full flex-1 border-0 bg-white" />
      ) : (
        <p className="flex flex-1 items-center justify-center p-6 text-center text-sm text-fg-subtle">Add an HTML file (for example index.html) to see the page here.</p>
      )}
      {consoleOpen && (
        <div className="flex h-[36%] min-h-28 shrink-0 flex-col border-t border-line bg-surface-2">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs text-fg-subtle">
            <span className="font-semibold text-fg">Console</span>
            <span>
              {lines.length === 0 ? "Nothing logged" : `${lines.length} message${lines.length === 1 ? "" : "s"}`}
              {errors > 0 && <span className="ml-1.5 text-danger">{`${errors} error${errors === 1 ? "" : "s"}`}</span>}
            </span>
            <button type="button" aria-label="Clear the console" title="Clear the console" disabled={!lines.length} onClick={() => setLines([])} className="ml-auto flex size-6 items-center justify-center rounded text-fg-muted hover:bg-hover disabled:opacity-35 [&_svg]:size-3.5">
              <Trash2 />
            </button>
          </div>
          <ol role="log" aria-label="Page console" className="cw-console min-h-0 flex-1 overflow-y-auto py-1 font-mono text-[12.5px] leading-[19px]">
            {lines.length === 0 && <li className="px-3 font-sans text-[13px] text-fg-subtle">What the page logs with console.log, and its errors, appear here.</li>}
            {lines.map((l, i) => (
              <li key={i} className={cn("flex gap-2 whitespace-pre-wrap break-words px-3", l.level === "error" ? "bg-danger-soft text-danger" : l.level === "warn" ? "bg-warning-soft text-warning" : "text-fg")}>
                <span className="min-w-0 flex-1">{l.text}</span>
                {l.count > 1 && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] text-fg-muted">{l.count}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
