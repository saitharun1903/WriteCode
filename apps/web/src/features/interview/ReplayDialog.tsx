"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import * as Y from "yjs";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { monacoLanguageForPath, type InterviewEvent } from "@cw/shared";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/primitives";
import { useLive } from "@/features/live/store";
import { useResolvedTheme } from "@/features/settings/store";
import { defineThemes } from "@/features/editor/monaco-setup";
import { cn } from "@/lib/cn";
import { formatRemaining } from "./monitor";
import { describeEvent } from "./report";
import { useInterviewUI } from "./ui";

type Update = [number, Uint8Array];

const fromBase64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

/** A pause in the typing longer than this is skipped during playback (when skipping is on). */
const IDLE_MS = 2500;

/** What is marked on the timeline, and how. */
const MARK: Partial<Record<InterviewEvent["kind"], { tone: string; label: string }>> = {
  run: { tone: "bg-accent", label: "Run" },
  submit: { tone: "bg-success", label: "Submission" },
  paste: { tone: "bg-danger", label: "Paste attempt" },
  "tab-hidden": { tone: "bg-warning", label: "Left the tab" },
  blur: { tone: "bg-warning", label: "Left the window" },
  "fullscreen-exit": { tone: "bg-warning", label: "Left full screen" },
  blocked: { tone: "bg-danger", label: "Blocked tool" },
  ended: { tone: "bg-fg-subtle", label: "End" },
};

/** How many updates happened at or before `t` (they are in time order). */
export function countAt(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first line (1-based) where two texts differ, or null when they are the same. */
export function firstChangedLine(before: string, after: string): number | null {
  if (before === after) return null;
  const a = before.split("\n");
  const b = after.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return Math.min(i + 1, b.length);
}

/**
 * Rebuilds the project as it was after the first `count` updates. Moving
 * forward applies only the new updates; moving back starts again from zero
 * (fast even for thousands of keystrokes).
 */
function useSnapshot(updates: Update[], count: number): Record<string, string> {
  const cursor = useRef<{ doc: Y.Doc; applied: number } | null>(null);
  return useMemo(() => {
    let c = cursor.current;
    if (!c || c.applied > count) {
      c?.doc.destroy();
      c = { doc: new Y.Doc(), applied: 0 };
      cursor.current = c;
    }
    for (; c.applied < count; c.applied++) Y.applyUpdate(c.doc, updates[c.applied]![1]);
    const files: Record<string, string> = {};
    for (const [path, text] of c.doc.getMap<Y.Text>("files")) files[path] = text.toString();
    return files;
  }, [updates, count]);
}

function Replay({ updates }: { updates: Update[] }) {
  const iv = useLive((s) => s.interview);
  const events = useLive((s) => s.interviewPrivate?.events ?? []);
  const theme = useResolvedTheme();
  const times = useMemo(() => updates.map(([t]) => t), [updates]);
  // The recording runs from the first change to the last change or event, whichever is later.
  const t0 = times[0] ?? 0;
  const tEnd = Math.max(times.at(-1) ?? t0, iv?.endedAt ?? 0, t0 + 1);
  const span = tEnd - t0;
  const [at, setAt] = useState(tEnd);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [skipIdle, setSkipIdle] = useState(true);
  const [file, setFile] = useState<string | null>(null);
  const count = countAt(times, at);
  const files = useSnapshot(updates, count);
  const paths = Object.keys(files).sort();
  const shown = file && files[file] !== undefined ? file : (paths.find((p) => /main\./i.test(p)) ?? paths[0] ?? null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<editor.IEditorDecorationsCollection | null>(null);
  const previous = useRef<{ file: string | null; text: string }>({ file: null, text: "" });

  const marks = useMemo(() => events.filter((e) => MARK[e.kind] && e.t >= t0 && e.t <= tEnd), [events, t0, tEnd]);
  const started = iv?.startedAt;
  const clock = (t: number) => (started && t >= started ? `+${formatRemaining(t - started)}` : `-${formatRemaining((started ?? t) - t)}`);
  // What had most recently happened at this point of the recording.
  const caption = [...marks].reverse().find((e) => e.t <= at);

  // Playback: the recording's clock advances `speed` times as fast as the wall clock,
  // and jumps over stretches where nothing was typed.
  const atRef = useRef(at);
  useEffect(() => {
    atRef.current = at;
  }, [at]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      let next = atRef.current + (now - last) * speed;
      last = now;
      if (skipIdle) {
        const upcoming = times[countAt(times, atRef.current)];
        if (upcoming !== undefined && upcoming - next > IDLE_MS) next = upcoming - 400;
        else if (upcoming === undefined) next = tEnd;
      }
      if (next >= tEnd) {
        setAt(tEnd);
        setPlaying(false);
      } else setAt(next);
    }, 40);
    return () => clearInterval(timer);
  }, [playing, speed, skipIdle, times, tEnd]);

  const seek = (t: number) => {
    setPlaying(false);
    // Just before the first change is the empty project the recording starts from.
    setAt(Math.min(tEnd, Math.max(t0 - 1, t)));
  };
  /** To the change before or after the current one. */
  const step = (by: 1 | -1) => {
    const target = by === 1 ? times[count] : times[count - 2];
    seek(target ?? (by === 1 ? tEnd : t0 - 1));
  };
  const toggle = () => {
    if (!playing && at >= tEnd) setAt(t0 - 1);
    setPlaying((p) => !p);
  };

  // The editor follows the typing: the line being changed is brought into view and marked.
  const text = shown ? (files[shown] ?? "") : "";
  useEffect(() => {
    const ed = editorRef.current;
    const before = previous.current;
    const line = before.file === shown ? firstChangedLine(before.text, text) : null;
    previous.current = { file: shown, text };
    if (!ed || line === null) return void decorations.current?.clear();
    const model = ed.getModel();
    if (!model) return;
    const at = Math.min(Math.max(1, line), model.getLineCount());
    ed.revealLineInCenterIfOutsideViewport(at);
    decorations.current?.clear();
    decorations.current = ed.createDecorationsCollection([{ range: { startLineNumber: at, startColumn: 1, endLineNumber: at, endColumn: 1 }, options: { isWholeLine: true, className: "cw-replay-line", linesDecorationsClassName: "cw-replay-gutter" } }]);
  }, [shown, text]);
  const onMount: OnMount = (ed) => {
    editorRef.current = ed;
  };

  return (
    <div
      className="space-y-3 outline-none"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key !== " " && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        if (e.key === " ") toggle();
        else step(e.key === "ArrowRight" ? 1 : -1);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={toggle}>
          {playing ? "Pause" : "Play"}
        </Button>
        <IconButton label="Previous change" shortcut="ArrowLeft" onClick={() => step(-1)} disabled={count === 0}>
          <SkipBack />
        </IconButton>
        <IconButton label="Next change" shortcut="ArrowRight" onClick={() => step(1)} disabled={count >= updates.length}>
          <SkipForward />
        </IconButton>
        <div role="radiogroup" aria-label="Speed" className="flex rounded-md border border-line-strong/70 p-0.5 text-xs">
          {[1, 2, 4, 8].map((x) => (
            <button key={x} type="button" role="radio" aria-checked={speed === x} onClick={() => setSpeed(x)} className={cn("rounded px-2 py-0.5", speed === x ? "bg-active text-fg" : "text-fg-subtle")}>
              {x}×
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="checkbox" checked={skipIdle} onChange={(e) => setSkipIdle(e.target.checked)} className="accent-[var(--accent)]" />
          Skip pauses
        </label>
        <span className="ml-auto font-mono text-xs text-fg-muted">
          {clock(Math.max(at, t0))} of {clock(tEnd)} · change {count} of {updates.length}
        </span>
      </div>

      <div className="relative pt-4">
        {marks.map((e, i) => (
          <button
            key={i}
            type="button"
            aria-label={`${clock(e.t)} ${describeEvent(e)}`}
            title={`${clock(e.t)} ${describeEvent(e)}`}
            onClick={() => seek(e.t)}
            className={cn("absolute top-0 h-3.5 w-1 -translate-x-1/2 rounded-sm transition-transform hover:scale-y-125", MARK[e.kind]!.tone)}
            style={{ left: `${((e.t - t0) / span) * 100}%` }}
          />
        ))}
        <input
          type="range"
          aria-label="Position in the recording"
          min={0}
          max={span}
          step={1}
          value={Math.max(0, at - t0)}
          onChange={(e) => {
            // The very start is before the first change: an empty project.
            const v = Number(e.target.value);
            seek(v <= 0 ? t0 - 1 : t0 + v);
          }}
          className="w-full accent-[var(--accent)]"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-subtle">
        {[
          ["bg-accent", "run"],
          ["bg-success", "submission"],
          ["bg-warning", "left the tab, window or full screen"],
          ["bg-danger", "paste attempt"],
        ].map(([tone, label]) => (
          <span key={label} className="flex items-center gap-1">
            <span className={cn("h-2.5 w-1 rounded-sm", tone)} />
            {label}
          </span>
        ))}
        <span className="ml-auto">Click a mark to go there. Space plays, the arrow keys step.</span>
      </div>
      <p aria-live="polite" className="min-h-5 truncate text-xs text-fg-muted">
        {caption ? (
          <>
            <span className="font-mono text-fg-subtle">{clock(caption.t)}</span> {describeEvent(caption)}
          </>
        ) : (
          "Nothing has happened yet at this point."
        )}
      </p>

      {paths.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {paths.map((p) => (
            <button key={p} type="button" onClick={() => setFile(p)} className={cn("rounded-md px-2 py-1 text-xs", p === shown ? "bg-active text-fg" : "text-fg-muted hover:bg-hover")}>
              {p}
            </button>
          ))}
        </div>
      )}
      <div className="relative h-[44vh] overflow-hidden rounded-lg border border-line-strong/60">
        {/* One editor for the whole replay: it is never taken down, even while the project is still empty. */}
        <Editor
          // One document for the whole replay, and not a project file: the main editor clears away
          // documents of files the project no longer has, which must never include this one.
          path="inmemory://replay/recording"
          value={text}
          language={shown ? monacoLanguageForPath(shown) : "plaintext"}
          theme={theme === "light" ? "cw-light" : "cw-dark"}
          beforeMount={defineThemes}
          onMount={onMount}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, renderLineHighlight: "none", domReadOnly: true, contextmenu: false }}
        />
        {!shown && <p className="absolute inset-0 bg-surface p-4 text-sm text-fg-subtle">Nothing has been written yet at this point.</p>}
      </div>
    </div>
  );
}

/** Replays how the candidate wrote the code, from the typing history the server recorded. */
export function ReplayDialog() {
  const open = useInterviewUI((s) => s.replayOpen);
  const [updates, setUpdates] = useState<Update[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void useLive
      .getState()
      .requestHistory()
      .then((u) => !cancelled && setUpdates(u.map(([t, b]) => [t, fromBase64(b)] as Update)));
    return () => {
      cancelled = true;
      setUpdates(null);
    };
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={useInterviewUI.getState().setReplayOpen} title="Replay the coding" description="The code as it was written, change by change, with what happened along the way." className="top-[4vh] max-w-4xl">
      {!updates ? (
        <p className="flex items-center gap-2 text-sm text-fg-subtle">
          <Spinner /> Loading the recording…
        </p>
      ) : updates.length === 0 ? (
        <p className="text-sm text-fg-subtle">Nothing has been recorded yet.</p>
      ) : (
        <Replay updates={updates} />
      )}
    </Dialog>
  );
}
