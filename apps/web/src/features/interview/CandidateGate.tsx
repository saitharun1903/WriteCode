"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Expand, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLive } from "@/features/live/store";
import { useWorkspace } from "@/features/projects/store";
import { InterviewClock } from "./Clock";
import { lockKeyboard, startLockdown, unlockKeyboard } from "./lockdown";
import { enterFullscreen, startMonitoring } from "./monitor";
import { useRestriction } from "./restrict";

/** Full screen, with the keys that switch windows kept by the page where the browser allows it. */
async function lockScreen(): Promise<boolean> {
  const full = await enterFullscreen();
  if (full) lockKeyboard();
  return full;
}

/**
 * The candidate's side of an interview: the rules to agree to before the
 * clock starts, the lockdown while it runs (no copy or paste, no other
 * windows), and a screen that covers the code whenever they have left.
 */
export function CandidateGate() {
  const restricted = useRestriction((s) => s.restricted);
  const iv = useLive((s) => s.interview);
  const interviewer = useLive((s) => s.participants.find((p) => p.role === "owner")?.name);
  const ready = useWorkspace((s) => !!s.sharedId);
  const [agreed, setAgreed] = useState(false);
  /** The candidate left the tab, the window or full screen and has not confirmed coming back. */
  const [away, setAway] = useState(false);
  /** Phones cannot go full screen; there, not being in full screen is not leaving. */
  const [canFullscreen, setCanFullscreen] = useState(true);
  const active = restricted && !!iv && ready && agreed && !iv.endedAt;

  useEffect(() => {
    if (!active) return;
    const send = useLive.getState().sendInterview;
    const stopMonitoring = startMonitoring(
      (kind) => {
        if ((kind === "fullscreen-exit" || kind === "fullscreen-enter") && !canFullscreen) return;
        send({ type: "interview-event", event: { kind } });
      },
      () => setAway(true),
    );
    const stopLockdown = startLockdown((text) => send({ type: "interview-event", event: { kind: "paste", chars: text.length, detail: text } }));
    return () => {
      stopMonitoring();
      stopLockdown();
    };
  }, [active, canFullscreen]);

  // When it is over, give the screen and the keyboard back.
  useEffect(() => {
    if (!iv?.endedAt) return;
    unlockKeyboard();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [iv?.endedAt]);

  if (!restricted || !iv || !ready) return null;

  if (iv.endedAt) {
    return (
      <div role="status" className="fixed inset-x-0 top-12 z-30 flex justify-center px-4 pt-2">
        <p className="flex items-center gap-2 rounded-lg border border-success/40 bg-canvas px-4 py-2 text-sm shadow-float">
          <CheckCircle2 className="size-4 shrink-0 text-success" />
          <span>
            The interview has ended{iv.endReason ? ` (${iv.endReason.replace(/^./, (c) => c.toLowerCase())})` : ""}. Your code has been handed in. Thank you!
          </span>
        </p>
      </div>
    );
  }

  const limit = iv.maxLeaves ?? 0;
  const left = iv.leaves ?? 0;

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
              <b>How it works:</b> write your code, press <b>Run</b> to check it on the example tests, and <b>Submit</b> to check it on all tests. You can submit as often as you like.
            </p>
            <div className="rounded-lg border border-warning/40 bg-warning-soft p-3">
              <p className="font-medium">Rules</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-muted">
                <li>Stay in this window, in full screen, until you finish.</li>
                <li>
                  {limit > 0
                    ? `Leaving the tab, the window or full screen is counted. The ${limit === 1 ? "first" : `${ordinal(limit)}`} time, the interview ends.`
                    : "Leaving the tab, the window or full screen is reported to the interviewer."}
                </li>
                <li>Copying from this page and pasting into it are turned off. You can still move your own code around.</li>
                <li>Code suggestions, the debugger, the visualizer and AI help are turned off.</li>
                <li>The interviewer sees your code as you type it, every run and every submission.</li>
              </ul>
            </div>
          </div>
          <Button
            variant="primary"
            className="h-10 w-full text-[15px]"
            icon={<Expand className="size-4" />}
            onClick={async () => {
              setCanFullscreen(await lockScreen());
              setAway(false);
              setAgreed(true);
              useLive.getState().sendInterview({ type: "interview-event", event: { kind: "consent" } });
            }}
          >
            {resuming ? "Continue in full screen" : "I agree: start the interview in full screen"}
          </Button>
        </div>
      </div>
    );
  }

  if (away) {
    const remaining = limit > 0 ? limit - left : null;
    return (
      <div role="alertdialog" aria-modal="true" aria-labelledby="interview-away" className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-canvas p-4">
        <div className="w-full max-w-md space-y-4 rounded-2xl border border-warning/50 bg-surface p-6 text-center shadow-float">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-warning-soft text-warning">
            <ShieldAlert className="size-6" />
          </span>
          <h2 id="interview-away" className="text-lg font-semibold">
            You left the interview window
          </h2>
          <p className="text-[13.5px] leading-relaxed text-fg-muted">
            The interviewer has been told.{" "}
            {remaining === null ? "Please stay in this window until you finish." : remaining <= 1 ? "If you leave once more, the interview ends and your code is handed in as it is." : `You have left ${left} of ${limit} times; at ${limit} the interview ends.`}
          </p>
          <InterviewClock className="justify-center text-sm" />
          <Button
            variant="primary"
            className="h-10 w-full text-[15px]"
            icon={<Expand className="size-4" />}
            onClick={async () => {
              setCanFullscreen(await lockScreen());
              setAway(false);
            }}
          >
            Return to the interview
          </Button>
        </div>
      </div>
    );
  }
  return null;
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}
