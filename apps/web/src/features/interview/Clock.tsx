"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useLive } from "@/features/live/store";
import { cn } from "@/lib/cn";
import { formatRemaining } from "./monitor";

/** Re-renders every second while `active`. */
function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** The interview clock: remaining time, or its state before and after. */
export function InterviewClock({ className }: { className?: string }) {
  const iv = useLive((s) => s.interview);
  const running = !!iv?.endsAt && !iv.endedAt;
  const now = useNow(running);
  if (!iv) return null;
  const left = iv.endsAt ? iv.endsAt - now : iv.durationMin * 60_000;
  const tone = iv.endedAt ? "text-fg-subtle" : !iv.startedAt ? "text-fg-muted" : left < 60_000 ? "text-danger" : left < 5 * 60_000 ? "text-warning" : "text-fg";
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono tabular-nums", tone, className)} aria-label="Time left" role="timer">
      <Clock className="size-3.5" />
      {iv.endedAt ? "Ended" : !iv.startedAt ? `${iv.durationMin}:00 · not started` : formatRemaining(left)}
    </span>
  );
}

