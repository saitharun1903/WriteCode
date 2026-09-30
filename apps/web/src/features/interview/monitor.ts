"use client";

import type { InterviewEventKind } from "@cw/shared";

type Report = (kind: InterviewEventKind, extra?: { detail?: string; chars?: number }) => void;

/**
 * What the candidate's browser reports during an interview (the candidate is
 * told about all of it before starting): leaving the tab, switching to
 * another window, leaving full screen, and pasting or dropping text.
 */
export function startMonitoring(report: Report): () => void {
  const onVisibility = () => report(document.hidden ? "tab-hidden" : "tab-visible");
  // A hidden tab also blurs the window; that is already reported as leaving the tab.
  const onBlur = () => !document.hidden && report("blur");
  const onFocus = () => report("focus");
  const onFullscreen = () => report(document.fullscreenElement ? "fullscreen-enter" : "fullscreen-exit");
  const pasted = (text: string) => {
    if (text) report("paste", { chars: text.length, detail: text });
  };
  // Capture phase: the editor's own input element receives pastes too.
  const onPaste = (e: ClipboardEvent) => pasted(e.clipboardData?.getData("text/plain") ?? "");
  const onDrop = (e: DragEvent) => pasted(e.dataTransfer?.getData("text/plain") ?? "");

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("fullscreenchange", onFullscreen);
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("drop", onDrop, true);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("fullscreenchange", onFullscreen);
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("drop", onDrop, true);
  };
}

export async function enterFullscreen(): Promise<boolean> {
  if (document.fullscreenElement) return true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    // Some browsers (iPhone Safari) do not allow full screen for pages.
    return false;
  }
}

/** Remaining time as m:ss (or h:mm:ss). */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}
