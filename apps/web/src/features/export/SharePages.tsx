"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, CheckCircle2, Copy, FileDown, FolderInput, TriangleAlert } from "lucide-react";
import { PRODUCT, SHARE_ID, TRANSFER_ID, cleanSharedCode, cleanTransferProject, getLanguage, type Project, type SharedCode } from "@cw/shared";
import { Spinner } from "@/components/ui/primitives";
import { FileIcon } from "@/features/explorer/file-icon";
import { projectRepo } from "@/features/projects/db";
import { LanguageMark } from "@/features/projects/StartScreen";
import { resolveTheme, useSettings } from "@/features/settings/store";
import { Brand } from "@/features/workspace/Logo";
import { cn } from "@/lib/cn";
import { highlight, languageOf } from "@/lib/highlight";
import { createId } from "@/lib/id";
import { openShare, openTransfer } from "./api";
import { DownloadDialog } from "./DownloadDialog";

const SITE = "writecode.in";
/** The project the editor opens first (the same key the workspace keeps). */
const LAST_PROJECT_KEY = "cw:last-project";

/** These pages follow the theme chosen in the editor, or the device's. */
function useAppTheme() {
  const theme = useSettings((s) => s.theme);
  useEffect(() => {
    useSettings.getState().hydrate();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolveTheme(theme);
  }, [theme]);
}

/** The id after the `#`, when it has the right shape. */
function useHashId(pattern: RegExp): string | null | undefined {
  const [id, setId] = useState<string | null>();
  useEffect(() => {
    const read = () => {
      const value = location.hash.slice(1);
      setId(pattern.test(value) ? value : null);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [pattern]);
  return id;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="cw-share-page h-dvh overflow-y-auto bg-canvas text-fg">
      <header className="mx-auto flex h-16 max-w-5xl items-center px-4 sm:px-6">
        <Link href="/" aria-label={PRODUCT.name} className="flex items-center">
          <Brand />
        </Link>
        <Link href="/" className="ml-auto flex h-9 items-center gap-1.5 rounded-full border border-line-strong/80 px-4 text-[13px] font-medium text-fg-muted transition-colors hover:border-accent/60 hover:text-fg">
          Write your own code <ArrowRight className="size-3.5" />
        </Link>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-10 sm:px-6">{children}</main>
      <Watermark />
    </div>
  );
}

/** The product's name at the foot of everything that is shared. */
function Watermark() {
  return (
    <footer className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-4 pb-10 text-center">
      <Link href="/" className="flex items-center gap-2 rounded-full border border-line-strong/60 bg-surface px-4 py-2 transition-colors hover:border-accent/60">
        <Brand className="gap-2 [&>span]:text-[14px] [&>svg]:size-[18px]" />
        <span className="text-[13px] text-fg-subtle">· {SITE}</span>
      </Link>
      <p className="max-w-md text-xs text-fg-subtle">Write, run, debug and visualize Java, Python, C, C++, JavaScript and TypeScript in your browser. Free, nothing to install.</p>
    </footer>
  );
}

function Notice({ tone, title, children }: { tone: "error" | "loading"; title: string; children?: React.ReactNode }) {
  return (
    <div className="cw-glow-card mx-auto mt-10 max-w-md">
      <div className="flex flex-col items-center gap-3 rounded-[19px] bg-surface p-8 text-center">
        {tone === "loading" ? <Spinner className="size-6" /> : <TriangleAlert className="size-7 text-warning" />}
        <h1 className="text-lg font-semibold">{title}</h1>
        {children && <div className="text-sm text-fg-muted">{children}</div>}
        {tone === "error" && (
          <Link href="/" className="cw-cta mt-2">
            Open {PRODUCT.name}
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- a shared link

function CodeView({ path, content, language }: { path: string; content: string; language: string }) {
  const lines = useMemo(() => highlight(content.replace(/\n+$/, ""), languageOf(path, language)), [content, path, language]);
  const width = String(lines.length).length;
  return (
    <pre aria-label={`Code of ${path}`} className="cw-code overflow-x-auto py-3 font-mono text-[13px] leading-[1.6]">
      {lines.map((tokens, i) => (
        <div key={i} className="flex px-1 hover:bg-hover/60">
          <span aria-hidden className="shrink-0 select-none pr-4 text-right text-fg-faint" style={{ width: `${width + 3}ch` }}>
            {i + 1}
          </span>
          <code className="whitespace-pre pr-6">
            {tokens.length ? (
              tokens.map((t, j) => (
                <span key={j} className={t.kind === "plain" ? undefined : `cw-tok-${t.kind}`}>
                  {t.text}
                </span>
              ))
            ) : (
              <br />
            )}
          </code>
        </div>
      ))}
    </pre>
  );
}

/** Puts the shared code in this browser as a project of the visitor's own, the one the editor opens next. */
async function openCopy(code: SharedCode) {
  const now = Date.now();
  const project: Project = { id: createId(), name: code.name, language: code.language, entryFile: code.entryFile, files: code.files, folders: [], stdin: "", createdAt: now, updatedAt: now };
  await projectRepo.put(project);
  try {
    localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(project.id));
  } catch {}
}

/** `/share#<id>`: code someone shared, to read, copy, download or open in the editor. */
export function SharedCodePage() {
  useAppTheme();
  const id = useHashId(SHARE_ID);
  const [code, setCode] = useState<SharedCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"open" | null>(null);
  const [downloading, setDownloading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!id) return;
    let live = true;
    openShare(id).then(
      (raw) => {
        // What comes from a link is checked like anything else from outside.
        const clean = cleanSharedCode(raw);
        if (!live) return;
        if (clean) setCode(clean);
        else setError("This shared code could not be read.");
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => {
    if (code) document.title = `${code.name} · shared on ${PRODUCT.name}`;
  }, [code]);

  if (id === undefined) return <Frame>{null}</Frame>;
  if (id === null) return <Frame><Notice tone="error" title="This link is not complete">Ask for the link again and open all of it.</Notice></Frame>;
  if (error) return <Frame><Notice tone="error" title="This code is not available">{error}</Notice></Frame>;
  if (!code) return <Frame><Notice tone="loading" title="Opening the shared code…" /></Frame>;

  const lang = getLanguage(code.language);
  const files = [...code.files].sort((a, b) => Number(b.path === code.entryFile) - Number(a.path === code.entryFile) || a.path.localeCompare(b.path));
  const shown = files.find((f) => f.path === file) ?? files[0]!;
  const lines = files.reduce((n, f) => n + f.content.replace(/\n+$/, "").split("\n").length, 0);
  const action = "flex h-9 items-center gap-1.5 rounded-lg border border-line-strong/80 px-3 text-[13px] font-medium text-fg transition-colors hover:border-accent/60 hover:bg-hover disabled:opacity-50";

  return (
    <Frame>
      <div className="cw-glow-card mt-2">
        <article className="overflow-hidden rounded-[19px] bg-surface">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line p-4 sm:p-5">
            <LanguageMark id={code.language} size={46} />
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-bold tracking-tight">{code.name}</h1>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                {lang ? `${lang.name} ${lang.version}` : code.language} · {files.length} file{files.length === 1 ? "" : "s"} · {lines} lines · shared {new Date(code.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={action}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shown.content);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  } catch {}
                }}
              >
                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className={action}
                disabled={busy !== null}
                onClick={() => setDownloading(true)}
              >
                <FileDown className="size-4" />
                Download
              </button>
              <button
                type="button"
                className="cw-cta"
                disabled={busy !== null}
                onClick={() => {
                  setBusy("open");
                  void openCopy(code).then(
                    () => router.push("/"),
                    () => {
                      setBusy(null);
                      setError("The code could not be saved in this browser. Private browsing or blocked site data can cause this.");
                    },
                  );
                }}
              >
                {busy === "open" ? <Spinner className="size-4" /> : <FolderInput className="size-4" />}
                Open in editor
              </button>
            </div>
          </div>
          {files.length > 1 && (
            <div role="tablist" aria-label="Files" className="flex gap-0.5 overflow-x-auto border-b border-line bg-surface-2/60 px-2">
              {files.map((f) => (
                <button
                  key={f.path}
                  role="tab"
                  aria-selected={f.path === shown.path}
                  title={f.path}
                  onClick={() => setFile(f.path)}
                  className={cn("relative flex h-9 shrink-0 items-center gap-1.5 px-3 text-[13px]", f.path === shown.path ? "text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-fg-muted hover:text-fg")}
                >
                  <FileIcon name={f.path} />
                  {f.path.split("/").pop()}
                </button>
              ))}
            </div>
          )}
          <CodeView path={shown.path} content={shown.content} language={code.language} />
        </article>
      </div>
      <DownloadDialog source={downloading ? { ...code, at: code.createdAt, activeFile: shown.path } : null} onClose={() => setDownloading(false)} />
      <p className="mt-3 text-center text-xs text-fg-subtle">A read-only copy. &ldquo;Open in editor&rdquo; gives you your own copy to run, debug and change.</p>
    </Frame>
  );
}

// ---------------------------------------------------------------- projects from another device

interface Received {
  added: Project[];
  updated: Project[];
  /** Already here, the same or newer. */
  kept: Project[];
}

/** Adds the projects to this browser. One that is already here is replaced only by a newer version of itself. */
export async function receiveProjects(incoming: unknown[], now = Date.now()): Promise<Received> {
  const result: Received = { added: [], updated: [], kept: [] };
  for (const raw of incoming) {
    const project = cleanTransferProject(raw, now);
    if (!project) continue;
    const here = await projectRepo.get(project.id);
    if (!here) {
      await projectRepo.put(project);
      result.added.push(project);
    } else if (here.updatedAt >= project.updatedAt) {
      result.kept.push(here);
    } else {
      // What belongs to this browser (breakpoints, an interview) stays with the project.
      await projectRepo.put({ ...here, ...project });
      result.updated.push(project);
    }
  }
  return result;
}

/** `/get#<id>`: opened by scanning the code another browser showed; its projects are added here. */
export function ReceivePage() {
  useAppTheme();
  const id = useHashId(TRANSFER_ID);
  const [result, setResult] = useState<Received | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;
    void (async () => {
      try {
        const { projects } = await openTransfer(id);
        const received = await receiveProjects(Array.isArray(projects) ? projects : []);
        // The code has done its work: a reload of this page should not ask for it again.
        history.replaceState(null, "", "/get");
        if (live) setResult(received);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  if (id === undefined) return <Frame>{null}</Frame>;
  if (result) {
    const fresh = [...result.added, ...result.updated];
    const all = [...fresh, ...result.kept];
    return (
      <Frame>
        <div className="cw-glow-card mx-auto mt-6 max-w-lg">
          <div className="rounded-[19px] bg-surface p-6 sm:p-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
                <CheckCircle2 className="size-8" />
              </span>
              <h1 className="text-xl font-bold tracking-tight">
                {fresh.length > 0 ? `${fresh.length} project${fresh.length === 1 ? " is" : "s are"} now on this device` : "Your projects are already here"}
              </h1>
              <p className="text-sm text-fg-muted">
                {fresh.length > 0
                  ? `They are saved in this browser${result.kept.length ? `; ${result.kept.length} more ${result.kept.length === 1 ? "was" : "were"} here already` : ""}. They also stay on the device they came from.`
                  : "This device already has these projects, the same or newer."}
              </p>
            </div>
            <ul aria-label="Projects" className="mt-5 max-h-64 space-y-1.5 overflow-y-auto">
              {all.map((p) => (
                <li key={p.id} className="flex items-center gap-3 rounded-lg border border-line-strong/60 px-3 py-2">
                  <LanguageMark id={p.language} size={28} className="rounded-md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-fg-subtle">
                      {getLanguage(p.language)?.name} · {p.files.length} file{p.files.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className={cn("shrink-0 text-xs", result.kept.includes(p) ? "text-fg-subtle" : "text-success")}>{result.added.includes(p) ? "Added" : result.updated.includes(p) ? "Updated" : "Already here"}</span>
                </li>
              ))}
            </ul>
            <Link href="/" className="cw-cta mt-6 w-full justify-center">
              Open my projects <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </Frame>
    );
  }
  if (error) return <Frame><Notice tone="error" title="The projects could not be brought here">{error}</Notice></Frame>;
  if (id === null) {
    return (
      <Frame>
        <Notice tone="error" title="Scan a code to bring projects here">
          On the device that has your projects, open {PRODUCT.name}, choose &ldquo;Move to another device&rdquo; and scan the code it shows.
        </Notice>
      </Frame>
    );
  }
  return <Frame><Notice tone="loading" title="Bringing your projects here…" /></Frame>;
}
