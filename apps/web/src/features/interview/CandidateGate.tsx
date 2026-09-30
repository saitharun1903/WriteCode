"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Expand, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { useSettings } from "@/features/settings/store";
import { InterviewClock } from "./Clock";
import { enterFullscreen, startMonitoring } from "./monitor";
import { useRestriction } from "./restrict";

function useFullscreen(): boolean {
  const [on, setOn] = useState(() => typeof document !== "undefined" && !!document.fullscreenElement);
  useEffect(() => {
    const update = () => setOn(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  return on;
}

/**
 * The candidate's side of an interview: the rules to agree to before the
 * clock starts, a reminder to go back to full screen, and reporting of tab,
 * window, full-screen and paste activity while the interview runs.
 */
export function CandidateGate() {
  const restricted = useRestriction((s) => s.restricted);
  const iv = useLive((s) => s.interview);
  const interviewer = useLive((s) => s.participants.find((p) => p.role === "owner")?.name);
  const ready = useWorkspace((s) => !!s.sharedId);
  const [agreed, setAgreed] = useState(false);
  const fullscreen = useFullscreen();
  const active = restricted && !!iv && ready && agreed && !iv.endedAt;

  useEffect(() => {
    if (!active) return;
    return startMonitoring((kind, extra) => useLive.getState().sendInterview({ type: "interview-event", event: { kind, ...extra } }));
  }, [active]);

  // When it is over, give the screen back.
  useEffect(() => {
    if (iv?.endedAt && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [iv?.endedAt]);

  if (!restricted || !iv || !ready) return null;

  if (iv.endedAt) {
    return (
      <div role="status" className="fixed inset-x-0 top-12 z-30 flex justify-center px-4 pt-2">
        <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-canvas px-4 py-2 text-sm shadow-float">
          <CheckCircle2 className="size-4 text-success" /> The interview has ended. Your code has been handed in. Thank you!
        </p>
      </div>
    );
  }

  if (!agreed) {
    const resuming = !!iv.startedAt;
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="interview-rules" className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-canvas/95 p-4 backdrop-blur">
        <div className="w-full max-w-lg space-y-5 rounded-2xl border border-line-strong bg-surface p-6 shadow-float">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
              <ShieldCheck className="size-5" />
            </span>
            <div>
              <h2 id="interview-rules" className="text-lg font-semibold">
                {resuming ? "Continue your interview" : "Coding interview"}
              </h2>
              <p className="text-sm text-fg-muted">
                {iv.title}
                {interviewer ? ` · with ${interviewer}` : ""}
              </p>
            </div>
          </div>
          <div className="space-y-3 text-[13.5px] leading-relaxed">
            <p>
              <b>Time:</b> {iv.durationMin} minutes{resuming ? " (the clock is already running)" : ", starting when you click the button below"}. When it runs out, your code is handed in automatically.
            </p>
            <p>
              <b>You can use:</b> the editor, Run, Program input and the sample tests. <b>Not available:</b> debugger, visualizer and AI help.
            </p>
            <div className="rounded-lg border border-warning/40 bg-warning-soft p-3">
              <p className="font-medium">The interviewer will see:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-muted">
                <li>your code as you type it, and every run</li>
                <li>when you leave this tab or window, and for how long</li>
                <li>when you leave full screen</li>
                <li>anything you paste into the page</li>
              </ul>
            </div>
          </div>
          <Button
            variant="primary"
            className="h-10 w-full text-[15px]"
            icon={<Expand className="size-4" />}
            onClick={async () => {
              await enterFullscreen();
              setAgreed(true);
              useSettings.getState().updateLayout({ assistantOpen: true });
              useLive.getState().sendInterview({ type: "interview-event", event: { kind: "consent" } });
            }}
          >
            {resuming ? "Continue in full screen" : "I agree: start the interview in full screen"}
          </Button>
        </div>
      </div>
    );
  }

  if (!fullscreen) {
    return (
      <div role="alert" className="fixed inset-x-0 top-12 z-30 flex justify-center px-4 pt-2">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/50 bg-canvas px-4 py-2 text-sm shadow-float">
          <span className="text-warning">You are not in full screen. The interviewer has been told.</span>
          <InterviewClock className="text-xs" />
          <Button size="sm" variant="primary" icon={<Expand className="size-3.5" />} onClick={() => void enterFullscreen()}>
            Back to full screen
          </Button>
        </div>
      </div>
    );
  }
  return null;
}
