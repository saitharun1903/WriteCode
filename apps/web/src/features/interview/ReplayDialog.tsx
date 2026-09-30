"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import * as Y from "yjs";
import { Pause, Play } from "lucide-react";
import { monacoLanguageForPath } from "@cw/shared";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/primitives";
import { useLive } from "@/features/live/store";
import { useResolvedTheme } from "@/features/settings/store";
import { defineThemes } from "@/features/editor/monaco-setup";
import { cn } from "@/lib/cn";
import { formatRemaining } from "./monitor";
import { describeEvent, WARN } from "./report";
import { useInterviewUI } from "./ui";

type Update = [number, Uint8Array];

const fromBase64 = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

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
  const [count, setCount] = useState(updates.length);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [file, setFile] = useState<string | null>(null);
  const files = useSnapshot(updates, count);
  const paths = Object.keys(files).sort();
  const shown = file && files[file] !== undefined ? file : (paths.find((p) => /main\./i.test(p)) ?? paths[0] ?? null);
  const t0 = updates[0]?.[0] ?? 0;
  const tEnd = updates.at(-1)?.[0] ?? t0;
  const now = count > 0 ? updates[count - 1]![0] : t0;
  const span = Math.max(1, tEnd - t0);

  // Playback in (sped-up) real time: jump to the update due at each tick.
  useEffect(() => {
    if (!playing) return;
    const startedAt = performance.now();
    const from = now;
    const timer = setInterval(() => {
      const target = from + (performance.now() - startedAt) * speed;
      let next = count;
      while (next < updates.length && updates[next]![0] <= target) next++;
      if (next >= updates.length) {
        setCount(updates.length);
        setPlaying(false);
      } else if (next !== count) setCount(next);
    }, 50);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when play state or speed changes
  }, [playing, speed]);

  const marks = events.filter((e) => WARN.has(e.kind) && e.t >= t0 && e.t <= tEnd);
  const clock = (t: number) => (iv?.startedAt && t >= iv.startedAt ? `+${formatRemaining(t - iv.startedAt)}` : new Date(t).toLocaleTimeString());

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          onClick={() => {
            if (!playing && count >= updates.length) setCount(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? "Pause" : "Play"}
        </Button>
        <div role="radiogroup" aria-label="Speed" className="flex rounded-md border border-line-strong/70 p-0.5 text-xs">
          {[1, 4, 16, 64].map((x) => (
            <button key={x} type="button" role="radio" aria-checked={speed === x} onClick={() => setSpeed(x)} className={cn("rounded px-2 py-0.5", speed === x ? "bg-active text-fg" : "text-fg-subtle")}>
              {x}×
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-xs text-fg-muted">
          {clock(now)} · change {count} of {updates.length}
        </span>
      </div>
      <div className="relative pt-3">
        {marks.map((e, i) => (
          <span
            key={i}
            title={`${clock(e.t)} ${describeEvent(e)}`}
            className={cn("absolute top-0 h-2.5 w-0.5 rounded", e.kind === "paste" ? "bg-danger" : "bg-warning")}
            style={{ left: `${((e.t - t0) / span) * 100}%` }}
          />
        ))}
        <input
          type="range"
          aria-label="Position in the recording"
          min={0}
          max={updates.length}
          value={count}
          onChange={(e) => {
            setPlaying(false);
            setCount(Number(e.target.value));
          }}
          className="w-full accent-[var(--accent)]"
        />
      </div>
      <p className="text-[11.5px] text-fg-subtle">
        Marks: <span className="text-danger">red</span> paste, <span className="text-warning">amber</span> left the tab, window or full screen. Hover a mark for details.
      </p>
      <div className="flex flex-wrap gap-1">
        {paths.map((p) => (
          <button key={p} type="button" onClick={() => setFile(p)} className={cn("rounded-md px-2 py-1 text-xs", p === shown ? "bg-active text-fg" : "text-fg-muted hover:bg-hover")}>
            {p}
          </button>
        ))}
      </div>
      <div className="h-[46vh] overflow-hidden rounded-lg border border-line-strong/60">
        {shown ? (
          <Editor
            path={`replay/${shown}`}
            value={files[shown] ?? ""}
            language={monacoLanguageForPath(shown)}
            theme={theme === "light" ? "cw-light" : "cw-dark"}
            beforeMount={defineThemes}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, renderLineHighlight: "none", domReadOnly: true }}
          />
        ) : (
          <p className="p-4 text-sm text-fg-subtle">No files at this point.</p>
        )}
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
    <Dialog open={open} onOpenChange={useInterviewUI.getState().setReplayOpen} title="Replay the coding" description="The project as it was at every change, from the start of the interview." className="top-[5vh] max-w-4xl">
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
