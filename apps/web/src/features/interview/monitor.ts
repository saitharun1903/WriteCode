"use client";

import type { InterviewEventKind } from "@cw/shared";

type Report = (kind: InterviewEventKind, extra?: { detail?: string; chars?: number }) => void;

/**
 * What the candidate's browser reports during an interview (the candidate is
 * told about all of it before starting): leaving the tab, switching to
 * another window and leaving full screen. `onLeave` is called for each of them.
 */
export function startMonitoring(report: Report, onLeave: () => void): () => void {
  const onVisibility = () => {
    report(document.hidden ? "tab-hidden" : "tab-visible");
    if (document.hidden) onLeave();
  };
  // A hidden tab also blurs the window; that is already reported as leaving the tab.
  const onBlur = () => {
    if (document.hidden) return;
    report("blur");
    onLeave();
  };
  const onFocus = () => report("focus");
  const onFullscreen = () => {
    report(document.fullscreenElement ? "fullscreen-enter" : "fullscreen-exit");
    if (!document.fullscreenElement) onLeave();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("fullscreenchange", onFullscreen);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("fullscreenchange", onFullscreen);
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
