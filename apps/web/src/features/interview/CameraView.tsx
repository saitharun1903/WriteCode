"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, Volume2, VolumeX } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { startCamera, useCamera } from "./camera";

/** Plays a camera stream. Sound only when `sound`; a browser that refuses to start with sound starts silent. */
function StreamVideo({ stream, sound, mirrored, className, onSilenced }: { stream: MediaStream; sound: boolean; mirrored?: boolean; className?: string; onSilenced?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = !sound;
    void video.play().catch(() => {
      // Browsers hold back sound until the page has been clicked: play silently and say so.
      if (!sound) return;
      video.muted = true;
      onSilenced?.();
      void video.play().catch(() => {});
    });
  }, [stream, sound, onSilenced]);
  return <video ref={ref} autoPlay playsInline muted={!sound} className={cn("size-full object-cover", mirrored && "-scale-x-100", className)} />;
}

/** Candidate, in the title bar: their own picture, small, so they know the camera is on. */
export function CameraChip() {
  const local = useCamera((s) => s.local);
  const error = useCamera((s) => s.localError);
  if (!local && !error) return null;
  return (
    <Tooltip content={local ? "Your camera and microphone are on for the interviewer" : `${error}. Click to try again.`}>
      <button type="button" disabled={!!local} onClick={() => void startCamera()} aria-label={local ? "Camera on" : "Camera off: turn it on"} className={cn("flex h-[30px] items-center gap-1.5 rounded-full border pl-0.5 pr-2.5 text-xs font-medium", local ? "border-danger/40 bg-danger/10 text-fg" : "border-warning/50 text-warning hover:bg-warning-soft")}>
        <span className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-surface-3">{local ? <StreamVideo stream={local} sound={false} mirrored /> : <VideoOff className="size-3.5" />}</span>
        {local ? (
          <>
            <span className="size-1.5 animate-pulse rounded-full bg-danger" /> On camera
          </>
        ) : (
          "Turn on camera"
        )}
      </button>
    </Tooltip>
  );
}

/** Candidate, before starting: a look at their own camera. */
export function CameraPreview({ className }: { className?: string }) {
  const local = useCamera((s) => s.local);
  return (
    <div className={cn("relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black/60 text-fg-subtle", className)}>
      {local ? <StreamVideo stream={local} sound={false} mirrored /> : <VideoOff className="size-7" />}
    </div>
  );
}

/**
 * Interviewer: the candidate's camera, with their voice. `name` and `online`
 * label the picture; without a stream it says why there is none.
 */
export function CandidateCamera({ id, name, online, started }: { id?: string; name?: string; online: boolean; started: boolean }) {
  const stream = useCamera((s) => (id ? s.remote[id] : undefined));
  const unavailable = useCamera((s) => (id ? s.unavailable[id] : undefined));
  const [sound, setSound] = useState(true);
  const hasVideo = !!stream?.getVideoTracks().length;
  const hasAudio = !!stream?.getAudioTracks().length;
  const reason = !name ? "Waiting for the candidate to open the link" : !online ? `${name} is not connected` : !started ? "The camera turns on when the candidate starts" : (unavailable ?? "Connecting to the camera…");
  return (
    <div aria-label="Candidate camera" className="relative aspect-video overflow-hidden rounded-xl border border-line bg-[#0b0c0f]">
      {stream ? (
        <StreamVideo stream={stream} sound={sound} onSilenced={() => setSound(false)} />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 px-4 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-white/[0.06] text-lg font-semibold text-white/70">{name ? name.trim().charAt(0).toUpperCase() : <Video className="size-5" />}</span>
          <span className="text-xs text-white/60">{reason}</span>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end gap-2 bg-gradient-to-t from-black/70 to-transparent p-2.5 pt-8">
        {name && (
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-white">
            <span className={cn("size-2 shrink-0 rounded-full", online ? "bg-success" : "bg-white/40")} />
            <span className="truncate">{name}</span>
          </span>
        )}
        {stream && (
          <span className="pointer-events-auto ml-auto flex items-center gap-1.5">
            {!hasVideo && <VideoOff className="size-4 text-white/70" aria-label="No picture" />}
            {hasAudio ? <Mic className="size-4 text-white/70" aria-hidden /> : <MicOff className="size-4 text-white/70" aria-label="No microphone" />}
            <button
              type="button"
              aria-label={sound ? "Mute the candidate" : "Hear the candidate"}
              aria-pressed={sound}
              onClick={() => setSound(!sound)}
              className={cn("flex size-7 items-center justify-center rounded-full text-white transition-colors", sound ? "bg-white/15 hover:bg-white/25" : "bg-danger/80 hover:bg-danger")}
            >
              {sound ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
