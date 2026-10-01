"use client";

import { create } from "zustand";
import type { LiveRtcSignal } from "@cw/shared";
import { rtcBridge, useLive } from "@/features/live/store";

/**
 * The candidate's camera and microphone, for the interviewer. The picture and
 * sound go straight from the candidate's browser to the interviewer's (WebRTC);
 * the live session only carries the few messages that set the connection up.
 * Nothing is recorded or stored.
 */

/** Public STUN servers: they tell each browser its own address so the two can reach each other. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];

interface CameraState {
  /** Candidate: this browser's camera and microphone, once allowed. */
  local: MediaStream | null;
  /** Candidate: why there is no camera (refused, none found). */
  localError: string | null;
  /** Interviewer: each candidate's stream, by participant id. */
  remote: Record<string, MediaStream>;
  /** Interviewer: candidates who have no camera to send, and why. */
  unavailable: Record<string, string>;
}

export const useCamera = create<CameraState>(() => ({ local: null, localError: null, remote: {}, unavailable: {} }));

const peers = new Map<string, RTCPeerConnection>();
/** Which attempt each connection belongs to (see LiveRtcSignal.call). */
const calls = new Map<string, string>();
const retry = new Map<string, ReturnType<typeof setTimeout>>();
/** Network addresses that arrived before the connection knew the other side; added once it does. */
const waiting = new Map<string, RTCIceCandidateInit[]>();

const send = (to: string, data: LiveRtcSignal) => useLive.getState().sendRtc(to, data);

function drop(id: string) {
  const pc = peers.get(id);
  peers.delete(id);
  calls.delete(id);
  waiting.delete(id);
  if (pc) {
    pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null;
    pc.close();
  }
}

function connection(id: string, call: string): RTCPeerConnection {
  drop(id);
  calls.set(id, call);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers.set(id, pc);
  waiting.set(id, []);
  pc.onicecandidate = (e) => e.candidate && send(id, { kind: "ice", call, candidate: e.candidate.toJSON() });
  return pc;
}

function why(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The candidate did not allow the camera";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found";
  if (name === "NotReadableError") return "The camera is in use by another program";
  return "The camera could not be started";
}

/** The other side's description is in: addresses can be added now, the early ones first. */
function described(id: string, pc: RTCPeerConnection) {
  if (peers.get(id) !== pc) return;
  for (const candidate of waiting.get(id) ?? []) void pc.addIceCandidate(candidate).catch(() => {});
  waiting.delete(id);
}

// ---------------------------------------------------------------- candidate

/** The candidate has started the interview: a camera that comes on from now is shared at once. */
let sharing = false;

/** Asks for the camera and microphone (the browser shows its own prompt). True when the camera is on. */
export async function startCamera(): Promise<boolean> {
  if (useCamera.getState().local) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    useCamera.setState({ localError: "This browser cannot share a camera" });
    return false;
  }
  try {
    // Small and light: a face at 15 frames a second is enough, and leaves the connection for the code.
    const local = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 }, facingMode: "user" }, audio: { echoCancellation: true, noiseSuppression: true } });
    useCamera.setState({ local, localError: null });
    // Allowed after the interview had started: the interviewer gets it now.
    if (sharing) queueMicrotask(shareCamera);
    // The camera being unplugged or switched off is worth knowing.
    for (const track of local.getTracks()) track.onended = () => useLive.getState().sendInterview({ type: "interview-event", event: { kind: "camera-off", detail: `${track.kind === "audio" ? "Microphone" : "Camera"} stopped` } });
    return true;
  } catch (e) {
    useCamera.setState({ local: null, localError: why(e) });
    return false;
  }
}

/** Candidate: offers the camera to every interviewer in the session (after the rules are agreed). */
export function shareCamera() {
  sharing = true;
  const { local, localError } = useCamera.getState();
  const live = useLive.getState();
  live.sendInterview({ type: "interview-event", event: local ? { kind: "camera-on" } : { kind: "camera-off", detail: localError ?? "No camera" } });
  for (const p of live.participants) if (p.role === "owner") void offer(p.id);
}

async function offer(to: string) {
  const { local, localError } = useCamera.getState();
  if (!local) return void send(to, { kind: "none", reason: localError ?? "The camera is off" });
  const call = crypto.randomUUID();
  const pc = connection(to, call);
  for (const track of local.getTracks()) pc.addTrack(track, local);
  try {
    await pc.setLocalDescription(await pc.createOffer());
    if (peers.get(to) === pc && pc.localDescription) send(to, { kind: "offer", call, sdp: pc.localDescription.sdp });
  } catch {
    drop(to);
  }
}

// ---------------------------------------------------------------- interviewer

/** Interviewer: asks a candidate for their camera. */
export function wantCamera(candidate: string) {
  if (peers.has(candidate)) return;
  send(candidate, { kind: "want" });
}

function lost(id: string) {
  drop(id);
  useCamera.setState((s) => {
    const remote = { ...s.remote };
    delete remote[id];
    return { remote };
  });
  // The network changed or the candidate reloaded: ask again while they are still here.
  if (retry.has(id)) return;
  retry.set(
    id,
    setTimeout(() => {
      retry.delete(id);
      const live = useLive.getState();
      if (live.role === "owner" && live.interview && !live.interview.endedAt && live.participants.some((p) => p.id === id)) wantCamera(id);
    }, 3000),
  );
}

async function answer(from: string, call: string, sdp: string) {
  const pc = connection(from, call);
  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    useCamera.setState((s) => {
      const unavailable = { ...s.unavailable };
      delete unavailable[from];
      return { remote: { ...s.remote, [from]: stream }, unavailable };
    });
  };
  pc.onconnectionstatechange = () => {
    if (peers.get(from) === pc && (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected")) lost(from);
  };
  try {
    await pc.setRemoteDescription({ type: "offer", sdp });
    described(from, pc);
    await pc.setLocalDescription(await pc.createAnswer());
    if (peers.get(from) === pc && pc.localDescription) send(from, { kind: "answer", call, sdp: pc.localDescription.sdp });
  } catch {
    lost(from);
  }
}

// ---------------------------------------------------------------- both

rtcBridge.onSignal = (from, data) => {
  const live = useLive.getState();
  if (!live.interview || live.interview.endedAt) return;
  const owner = live.role === "owner";
  const pc = peers.get(from);
  switch (data.kind) {
    case "want":
      if (!owner) void offer(from);
      return;
    case "offer":
      if (owner && typeof data.sdp === "string" && typeof data.call === "string") void answer(from, data.call, data.sdp);
      return;
    case "answer":
      if (!owner && pc && typeof data.sdp === "string" && data.call === calls.get(from) && pc.signalingState === "have-local-offer") {
        void pc
          .setRemoteDescription({ type: "answer", sdp: data.sdp })
          .then(() => described(from, pc))
          .catch(() => drop(from));
      }
      return;
    case "ice": {
      if (!pc || !data.candidate || data.call !== calls.get(from)) return;
      const early = waiting.get(from);
      if (early) early.push(data.candidate as RTCIceCandidateInit);
      else void pc.addIceCandidate(data.candidate as RTCIceCandidateInit).catch(() => {});
      return;
    }
    case "none":
      if (owner) {
        drop(from);
        useCamera.setState((s) => ({ unavailable: { ...s.unavailable, [from]: data.reason ?? "The camera is off" } }));
      }
      return;
  }
};

/** Turns the camera off and closes every connection. */
export function stopCamera() {
  for (const id of [...peers.keys()]) drop(id);
  for (const t of retry.values()) clearTimeout(t);
  retry.clear();
  for (const track of useCamera.getState().local?.getTracks() ?? []) {
    track.onended = null;
    track.stop();
  }
  sharing = false;
  useCamera.setState({ local: null, localError: null, remote: {}, unavailable: {} });
}

if (typeof window !== "undefined") {
  useLive.subscribe((s, prev) => {
    // The interview is over, or the session was left: the camera goes off at once.
    if ((prev.interview && !s.interview) || (s.interview?.endedAt && !prev.interview?.endedAt)) return stopCamera();
    if (!s.interview || s.interview.endedAt || s.participants === prev.participants) return;
    const here = new Set(s.participants.map((p) => p.id));
    for (const id of peers.keys()) if (!here.has(id)) (s.role === "owner" ? lost : drop)(id);
    // Interviewer: ask each candidate who is here for their camera.
    if (s.role === "owner") for (const p of s.participants) if (p.role !== "owner") wantCamera(p.id);
  });
}
