"use client";

import { create } from "zustand";
import type {
  InterviewEvent,
  InterviewPrivate,
  InterviewPublic,
  InterviewSetup,
  LiveClientMessage,
  LiveJoinRole,
  LiveParticipant,
  LivePresence,
  LiveRtcSignal,
  InterviewVerdict,
  LiveRole,
  LiveRunNotice,
  LiveServerMessage,
  Project,
} from "@cw/shared";
import { LIVE_LIMITS } from "@cw/shared";
import { useRestriction } from "@/features/interview/restrict";
import { useSettings } from "@/features/settings/store";
import { useTests } from "@/features/tests/store";
import { toast } from "@/components/ui/toast";
import { API_URL } from "@/features/execution/api";
import { useExecution, watchedInput } from "@/features/execution/store";
import { useWorkspace } from "@/features/projects/store";
import { createId } from "@/lib/id";
import { bindProject, isReady, metaOf, readProject, upgradeDoc, writeProject, type Binding } from "./bind";
import { LiveClient, type LiveStatus } from "./client";
import { startPresence } from "./presence";

export type SessionStatus = "idle" | "starting" | LiveStatus | "waiting" | "ended" | "removed" | "failed";

interface LiveState {
  status: SessionStatus;
  roomId: string | null;
  /** This person is the owner (started the session from their own project). */
  owner: boolean;
  me: LiveParticipant | null;
  role: LiveRole | null;
  participants: LiveParticipant[];
  defaultRole: LiveJoinRole;
  /** Other people's file, cursor and paused line, by participant id. */
  presence: Record<string, LivePresence>;
  following: string | null;
  error: string | null;
  panelOpen: boolean;
  /** A link was opened and we are asking for a name before joining. */
  joinPrompt: string | null;
  name: string;

  setPanelOpen: (open: boolean) => void;
  /** Starts sharing the open project. */
  start: (name: string) => Promise<void>;
  /** Joins someone else's session from its link. */
  join: (roomId: string, name: string) => void;
  /** Leaves (guests) or disconnects (owner; the session goes on without them). */
  leave: () => void;
  /** Owner: ends the session for everyone. */
  end: () => void;
  setDefaultRole: (role: LiveJoinRole) => void;
  setRole: (id: string, role: LiveJoinRole) => void;
  remove: (id: string) => void;
  follow: (id: string | null) => void;
  /** Guest: keeps a copy of the shared project in their own projects. */
  saveCopy: () => Promise<void>;
  /** After an ended or removed session: back to the start screen. */
  dismiss: () => void;
  /** Reconnects as owner to the session of a project this browser shared earlier. */
  resumeOwned: (projectId: string) => void;

  /** Interview sessions: the problem and clock (everyone). */
  interview: InterviewPublic | null;
  /** Interview sessions, interviewer only: hidden tests, notes, rating, activity. */
  interviewPrivate: InterviewPrivate | null;
  /** Starts an interview on the open project (the interviewer owns it). */
  startInterview: (name: string, setup: InterviewSetup) => Promise<boolean>;
  /** Sends an interview message (setup, extend, end, notes, events). */
  sendInterview: (message: Extract<LiveClientMessage, { type: `interview-${string}` }>) => boolean;
  /** Candidate: shows a run of the sample tests to the interviewer (`testIds` in the order they ran). */
  announceTests: (executionId: string, testIds: string[]) => void;
  /** Interviewer: the typing history for replay (document updates with their times). */
  requestHistory: () => Promise<[number, string][]>;
  /** Interview: a camera set-up message for one participant (see interview/camera.ts). */
  sendRtc: (to: string, data: LiveRtcSignal) => boolean;
  /**
   * Candidate: the interview that has just finished, shown once the session has
   * closed for them. `code` is what they wrote, so they can keep a copy.
   */
  finished: { title: string; reason?: string; verdict?: InterviewVerdict; code?: Project } | null;
  /**
   * Interviewer: the interview is over and kept, so its session closes for
   * everyone. What is on screen from then on is the kept interview.
   */
  closeFinishedInterview: () => void;
  /**
   * The interview on screen is a kept one: its session has closed, and what is shown
   * (overview, tests, notes, report, replay) comes from the record saved with the project.
   */
  archived: boolean;
  clearFinished: () => void;
  /** Owner: emails the link through the server. */
  emailInvites: (emails: string[]) => Promise<{ sent: number; failed: string[] }>;
}

const NAME_KEY = "cw:live:name";
const CLIENT_KEY = "cw:live:key";
const OWNED_KEY = "cw:live:owned";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** Sessions this browser owns, by project id: the owner token lets it rejoin as owner after a reload. */
type Owned = Record<string, { roomId: string; ownerToken: string }>;

/** Why a session could not continue, in words, for a close without a message from the server. */
export function closeMessage(code: number | undefined, reason?: string): string {
  switch (code) {
    case 0:
      return "Could not reach the live server. Check your internet connection and try again.";
    case 4004:
      return "This live session has ended or the link is wrong.";
    case 4008:
      return "This live session is full.";
    case 4429:
      return "The connection was sending too much at once. Try again in a moment.";
    case 1008:
      return "Live sessions can't be opened from this address. Open the site at writecode.in and try again.";
    default:
      return reason ? `Could not connect to the live session: ${reason}. Try again.` : "Could not connect to the live session. Try again.";
  }
}

function clientKey(): string {
  let key = read<string | null>(CLIENT_KEY, null);
  if (!key) {
    key = createId().replace(/-/g, "");
    write(CLIENT_KEY, key);
  }
  return key;
}

export function liveLink(roomId: string): string {
  return `${location.origin}/live#${roomId}`;
}

interface Session {
  client: LiveClient;
  roomId: string;
  ownerToken?: string;
  projectId: string | null;
  owner: boolean;
  binding: Binding | null;
  stopPresence: (() => void) | null;
  synced: boolean;
  announced: Set<string>;
  /** The owner is closing the session of a finished interview: it goes without a word. */
  quiet?: boolean;
}

let session: Session | null = null;

/** Camera set-up messages go to interview/camera.ts, which registers here (it imports this store). */
export const rtcBridge: { onSignal: (from: string, data: LiveRtcSignal) => void } = { onSignal: () => {} };
/** Waiting for the interview history the interviewer asked for. */
let historyWaiters: ((updates: [number, string][]) => void)[] = [];

const ALERT: Partial<Record<InterviewEvent["kind"], (e: InterviewEvent) => string>> = {
  "tab-hidden": (e) => `${e.who ?? "The candidate"} left the tab`,
  blur: (e) => `${e.who ?? "The candidate"} switched to another window`,
  "fullscreen-exit": (e) => `${e.who ?? "The candidate"} left full screen`,
  paste: (e) => `${e.who ?? "The candidate"} tried to paste ${e.chars ?? 0} characters (blocked)`,
  submit: (e) => (e.who ? `${e.who} submitted` : "The code handed in was checked"),
  blocked: (e) => `${e.who ?? "The candidate"} tried to use the ${e.detail ?? "a blocked tool"}`,
};

export const useLive = create<LiveState>((set, get) => {
  const teardown = () => {
    if (!session) return;
    const s = session;
    session = null;
    s.binding?.unbind();
    s.stopPresence?.();
    s.client.destroy();
    useWorkspace.getState().setReadOnly(false);
    useRestriction.setState({ restricted: false });
    set({ interview: null, interviewPrivate: null, archived: false });
  };

  const applyRole = (role: LiveRole) => {
    if (!session) return;
    session.client.setWritable(role !== "viewer");
    const ws = useWorkspace.getState();
    if (ws.project && ws.project.id === session.projectId) ws.setReadOnly(role === "viewer");
  };

  /** The document is in sync: set up the project on this side and bind it. */
  const onSynced = () => {
    const s = session;
    if (!s || s.synced) return;
    const doc = s.client.doc;
    if (s.owner) {
      const project = useWorkspace.getState().project;
      if (!project || project.id !== s.projectId) return;
      // A fresh session gets the project; a resumed one brings back what others changed meanwhile.
      if (!isReady(doc)) writeProject(doc, project);
      else {
        upgradeDoc(doc, project);
        const shared = readProject(doc, project.files.map((f) => f.path));
        useWorkspace.getState().applyShared({ files: shared.files, folders: shared.folders, entryFile: shared.entryFile, stdin: shared.stdin, name: shared.name, tests: shared.tests });
      }
    } else {
      if (!isReady(doc)) {
        set({ status: "waiting" });
        const meta = metaOf(doc);
        const onMeta = () => {
          if (!isReady(doc)) return;
          meta.unobserve(onMeta);
          onSynced();
        };
        meta.observe(onMeta);
        return;
      }
      const shared = readProject(doc);
      const project: Project = {
        id: `live-${s.roomId}`,
        name: shared.name,
        language: shared.language,
        files: shared.files,
        folders: shared.folders,
        entryFile: shared.entryFile,
        stdin: shared.stdin,
        tests: shared.tests,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      useWorkspace.getState().openShared(project);
      s.projectId = project.id;
      applyRole(get().role ?? "viewer");
    }
    s.synced = true;
    const projectId = s.projectId!;
    s.binding = bindProject(doc, projectId, () => get().role !== "viewer");
    s.stopPresence = startPresence(s.client, projectId, {
      me: () => get().me,
      participants: () => get().participants,
      following: () => get().following,
      stopFollowing: () => set({ following: null }),
      onChange: (presence) => set({ presence }),
    });
    set({ status: "connected" });
    // View-only people follow the owner by default, like a presentation.
    if (get().role === "viewer" && !get().following) {
      const presenter = get().participants.find((p) => p.role === "owner");
      if (presenter) set({ following: presenter.id });
    }
  };

  /** Shows a run someone else started: in the Run window, or the Tests panel for test runs. */
  const watchRun = (run: LiveRunNotice) => {
    const ws = useWorkspace.getState();
    if (!session || ws.project?.id !== session.projectId) return;
    if (run.mode === "test") {
      useTests.getState().watch({ executionId: run.executionId, testIds: run.tests ?? [], by: run.by.name });
      useSettings.getState().updateLayout({ bottomOpen: true, bottomTab: "tests" });
      return;
    }
    // Everyone who can edit may type the program's input; view-only people watch.
    const interactive = !!run.interactive && get().role !== "viewer";
    useExecution.getState().watch({ executionId: run.executionId, mode: run.mode, entry: run.entry, by: run.by.name, interactive });
  };

  const onMessage = (msg: LiveServerMessage) => {
    switch (msg.type) {
      case "welcome":
        set({ me: msg.you, role: msg.you.role, participants: msg.participants, defaultRole: msg.defaultRole, error: null, interview: msg.interview ?? null, interviewPrivate: msg.interviewPrivate ?? null });
        // In an interview, everyone but the interviewer is a candidate: editor and Run only.
        useRestriction.setState({ restricted: !!msg.interview && msg.you.role !== "owner" });
        // The interviewer's tools open on the right (the candidate has a layout of their own).
        if (msg.interview && msg.you.role === "owner") useSettings.getState().updateLayout({ assistantOpen: true });
        applyRole(msg.you.role);
        if (msg.run && session && !session.owner && session.synced) watchRun(msg.run);
        return;
      case "participants": {
        const me = msg.participants.find((p) => p.id === get().me?.id) ?? get().me;
        const owner = get().participants.find((p) => p.role === "owner");
        if (owner && me?.role !== "owner" && !msg.participants.some((p) => p.role === "owner") && !get().interview?.endedAt) {
          const minutes = Math.round(LIVE_LIMITS.ownerAwaySeconds / 60);
          toast.info(`${owner.name} disconnected`, get().interview ? `If they are not back in ${minutes} minutes, the interview ends and your code is handed in.` : `If they are not back in ${minutes} minutes, this session closes. Save a copy to keep the code.`);
        }
        set({ participants: msg.participants, me });
        if (get().following && !msg.participants.some((p) => p.id === get().following)) set({ following: null });
        return;
      }
      case "role": {
        const before = get().role;
        set({ role: msg.role, me: get().me ? { ...get().me!, role: msg.role } : null });
        applyRole(msg.role);
        if (before && before !== msg.role) {
          if (msg.role === "viewer") toast.info("You are now view-only", "The owner can give you edit access again.");
          else toast.success("You can edit now", "The owner gave you edit access.");
        }
        return;
      }
      case "default-role":
        set({ defaultRole: msg.role });
        return;
      case "run":
        watchRun(msg.run);
        return;
      case "input-error":
        useExecution.setState((s) => ({ run: s.run && s.run.id === msg.executionId ? { ...s.run, inputError: msg.message } : s.run }));
        return;
      case "interview":
        set({ interview: msg.state });
        return;
      case "interview-private":
        set({ interviewPrivate: msg.state });
        return;
      case "interview-event": {
        const priv = get().interviewPrivate;
        if (priv) set({ interviewPrivate: { ...priv, events: [...priv.events, msg.event] } });
        const alert = ALERT[msg.event.kind];
        if (alert) toast.info(alert(msg.event), (msg.event.kind === "paste" || msg.event.kind === "submit") && msg.event.detail ? msg.event.detail.slice(0, 120) : undefined);
        return;
      }
      case "rtc":
        rtcBridge.onSignal(msg.from, msg.data);
        return;
      case "interview-history": {
        const waiters = historyWaiters;
        historyWaiters = [];
        for (const w of waiters) w(msg.updates);
        return;
      }
      case "ended":
        set({ status: "ended" });
        return;
      case "removed":
        set({ status: "removed" });
        return;
      case "error":
        set({ error: msg.message });
        if (msg.code === "too-large") toast.error("Live session is full", msg.message);
        return;
    }
  };

  const connect = (roomId: string, name: string, projectId: string | null, ownerToken?: string) => {
    teardown();
    // A kept interview on screen gives way to its live session.
    if (get().archived) set({ interview: null, interviewPrivate: null, archived: false, role: null });
    set({ roomId, owner: !!ownerToken, status: "connecting", error: null, participants: [], presence: {}, following: null, me: null, role: null, name });
    const s: Session = {
      roomId,
      ownerToken,
      projectId,
      owner: !!ownerToken,
      binding: null,
      stopPresence: null,
      synced: false,
      announced: new Set(),
      client: new LiveClient({
        roomId,
        name,
        clientKey: clientKey(),
        ownerToken,
        onMessage: (m) => session === s && onMessage(m),
        onSynced: () => session === s && onSynced(),
        onStatus: (status, code, reason) => {
          if (session !== s) return;
          if (status === "closed") {
            const ended = code === 4000 || get().status === "ended";
            const removed = code === 4001 || get().status === "removed";
            if (s.owner && (ended || code === 4004)) forgetOwned(s.projectId);
            if (s.owner && s.quiet) {
              teardownKeepProject();
              set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null, error: null, panelOpen: false });
              return;
            }
            // A candidate whose interview is over: nothing of it stays open, only a word of thanks.
            const iv = get().interview;
            if (!s.owner && iv?.endedAt) {
              const shared = useWorkspace.getState().sharedId;
              const open = useWorkspace.getState().project;
              // What they wrote, in case they want to keep it.
              const code = shared && open?.id === shared ? structuredClone(open) : undefined;
              teardown();
              set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null, error: null, finished: { title: iv.title, reason: iv.endReason, verdict: iv.verdicts?.at(-1), code } });
              if (shared && useWorkspace.getState().project?.id === shared) useWorkspace.getState().closeProject();
              history.replaceState(null, "", "/");
              return;
            }
            // The owner came back to a session that closed while they were away: say so, and let them share again.
            if (s.owner && code === 4004) {
              teardownKeepProject();
              set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null, error: null });
              if (!useWorkspace.getState().project?.interview) toast.info("Your live session has closed", `It closes by itself when you are away for ${Math.round(LIVE_LIMITS.ownerAwaySeconds / 60)} minutes. Share again to start a new one.`);
              return;
            }
            set({ status: ended ? "ended" : removed ? "removed" : "failed", error: get().error ?? closeMessage(code, reason) });
            teardownKeepProject();
            return;
          }
          // A refusal that a retry got past is no longer worth showing.
          if (status === "connected" && get().error) set({ error: null });
          if (status === "connected" && s.synced) return set({ status: "connected" });
          if (status !== "connected") set({ status });
        },
      }),
    };
    session = s;
    s.client.start();
  };

  /** Stops syncing but leaves the project open (a guest can still save a copy). */
  const teardownKeepProject = () => {
    const readOnly = useWorkspace.getState().readOnly;
    teardown();
    // Nothing more will change; let a former viewer look around freely.
    if (readOnly) useWorkspace.getState().setReadOnly(false);
  };

  /** Creates a session (or an interview) for the open project and connects as its owner. */
  const createRoom = async (name: string, body: { interview?: InterviewSetup }): Promise<boolean> => {
    const ws = useWorkspace.getState();
    const project = ws.project;
    if (!project || ws.sharedId) return false;
    const clean = name.trim().slice(0, 40) || "Owner";
    write(NAME_KEY, clean);
    set({ status: "starting", error: null, name: clean });
    let created: { id: string; ownerToken: string };
    try {
      const res = await fetch(`${API_URL}/api/v1/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `Request failed (${res.status})`);
      }
      created = (await res.json()) as { id: string; ownerToken: string };
    } catch (e) {
      set({ status: "idle", error: e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Could not reach the server. Check your connection and try again." });
      return false;
    }
    const owned = read<Owned>(OWNED_KEY, {});
    owned[project.id] = { roomId: created.id, ownerToken: created.ownerToken };
    write(OWNED_KEY, owned);
    connect(created.id, clean, project.id, created.ownerToken);
    return true;
  };

  const forgetOwned = (projectId: string | null) => {
    if (!projectId) return;
    const owned = read<Owned>(OWNED_KEY, {});
    delete owned[projectId];
    write(OWNED_KEY, owned);
  };

  return {
    status: "idle",
    roomId: null,
    owner: false,
    me: null,
    role: null,
    participants: [],
    defaultRole: "editor",
    presence: {},
    following: null,
    error: null,
    panelOpen: false,
    joinPrompt: null,
    name: typeof window === "undefined" ? "" : read<string>(NAME_KEY, ""),

    setPanelOpen: (panelOpen) => set({ panelOpen }),

    start: async (name) => {
      await createRoom(name, {});
    },

    startInterview: (name, setup) => createRoom(name, { interview: setup }),

    sendInterview: (message) => session?.client.send(message) ?? false,
    sendRtc: (to, data) => session?.client.send({ type: "rtc", to, data }) ?? false,
    finished: null,
    clearFinished: () => set({ finished: null }),

    closeFinishedInterview() {
      const s = session;
      if (!s?.owner || !get().interview?.endedAt) return;
      s.quiet = true;
      forgetOwned(s.projectId);
      s.client.send({ type: "end" });
      // The server closes every connection, ours included; if it does not answer, close ours anyway.
      setTimeout(() => {
        if (session !== s) return;
        teardownKeepProject();
        set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null, error: null, panelOpen: false });
      }, 1500);
    },
    archived: false,

    announceTests(executionId, testIds) {
      if (!session || session.announced.has(executionId)) return;
      session.announced.add(executionId);
      session.client.send({ type: "run", executionId, mode: "test", entry: "", tests: testIds });
    },

    requestHistory() {
      // A kept interview replays from the history saved with it.
      if (get().archived) return Promise.resolve(useWorkspace.getState().project?.interview?.history ?? []);
      if (!session?.owner) return Promise.resolve([]);
      return new Promise((resolve) => {
        historyWaiters.push(resolve);
        if (!session!.client.send({ type: "interview-history" })) {
          historyWaiters = historyWaiters.filter((w) => w !== resolve);
          resolve([]);
        }
      });
    },

    async emailInvites(emails) {
      if (!session?.ownerToken) throw new Error("Only the person who started the session can email invitations.");
      const res = await fetch(`${API_URL}/api/v1/live/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: session.roomId, ownerToken: session.ownerToken, emails, from: get().name }),
      }).catch(() => null);
      if (!res) throw new Error("Could not reach the server. Check your connection and try again.");
      const body = (await res.json().catch(() => ({}))) as { message?: string | string[]; sent?: number; failed?: string[] };
      if (!res.ok) throw new Error(Array.isArray(body.message) ? body.message.join(", ") : (body.message ?? `Request failed (${res.status})`));
      return { sent: body.sent ?? 0, failed: body.failed ?? [] };
    },

    interview: null,
    interviewPrivate: null,
    join(roomId, name) {
      const clean = name.trim().slice(0, 40) || "Guest";
      write(NAME_KEY, clean);
      set({ joinPrompt: null });
      void useWorkspace
        .getState()
        .flush()
        .then(() => connect(roomId, clean, null));
    },

    leave() {
      const wasGuest = session && !session.owner;
      teardown();
      set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null, panelOpen: false });
      if (wasGuest && useWorkspace.getState().sharedId) useWorkspace.getState().closeProject();
    },

    end() {
      if (!session?.owner) return;
      forgetOwned(session.projectId);
      session.client.send({ type: "end" });
      // The server closes everyone's connection, ours included.
      set({ panelOpen: false });
      setTimeout(() => {
        if (get().status !== "idle") {
          teardown();
          set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null });
        }
      }, 1500);
    },

    setDefaultRole: (role) => session?.client.send({ type: "default-role", role }),
    setRole: (id, role) => session?.client.send({ type: "set-role", id, role }),
    remove: (id) => session?.client.send({ type: "remove", id }),
    follow: (id) => set({ following: id }),

    async saveCopy() {
      const copy = await useWorkspace.getState().saveCopy();
      if (!copy) return;
      toast.success(`Saved "${copy.name}"`, "It is in your projects.");
      if (get().status === "ended" || get().status === "removed" || get().status === "failed") {
        get().dismiss();
        await useWorkspace.getState().openProject(copy.id);
      }
    },

    resumeOwned(projectId) {
      const owned = read<Owned>(OWNED_KEY, {})[projectId];
      if (!owned || session || get().joinPrompt || (get().status !== "idle" && get().status !== "failed")) return;
      connect(owned.roomId, read<string>(NAME_KEY, "") || get().name || "Owner", projectId, owned.ownerToken);
    },

    dismiss() {
      const shared = useWorkspace.getState().sharedId;
      teardown();
      set({ status: "idle", roomId: null, participants: [], presence: {}, following: null, me: null, role: null, error: null });
      if (shared && useWorkspace.getState().project?.id === shared) useWorkspace.getState().closeProject();
    },
  };
});

/**
 * Undo/redo in a live session undoes only this person's own changes (not the
 * others'). Null when there is no live session, so the editor's own undo runs.
 */
export function liveHistory(which: "undo" | "redo", path: string | null): boolean | null {
  if (!session?.binding) return null;
  if (path) session.binding[which](path);
  return true;
}

/**
 * Shows the interview kept with the open project when it has no live session
 * (it ended and closed, or the server no longer has it). An interview that
 * never ended is shown as ended: nothing more can happen in it.
 */
function showKeptInterview() {
  const ws = useWorkspace.getState();
  const record = ws.project?.interview;
  const live = useLive.getState();
  if (!record || ws.sharedId || session || live.interview || (live.status !== "idle" && live.status !== "failed")) return;
  const pub = record.public.endedAt ? record.public : { ...record.public, endedAt: record.savedAt, endReason: record.public.endReason ?? "The session closed" };
  useLive.setState({ interview: { ...pub, judging: false }, interviewPrivate: record.private, role: "owner", archived: true, status: "idle", error: null });
  useSettings.getState().updateLayout({ assistantOpen: true });
}

/** Asks for a name before joining the session in the page's link (`/live#<id>`). */
export function promptJoin(roomId: string) {
  useLive.setState({ joinPrompt: roomId });
}

if (typeof window !== "undefined") {
  // Owner's own session follows their project: leaving the project disconnects, reopening resumes.
  useWorkspace.subscribe((s, prev) => {
    if (s.project?.id === prev.project?.id) return;
    if (session && s.project?.id !== session.projectId && session.synced) {
      const guest = !session.owner;
      useLive.getState().leave();
      if (guest) toast.info("You left the live session", "Open the link again to rejoin.");
    }
    // A kept interview belongs to the project that was just left.
    if (useLive.getState().archived) useLive.setState({ interview: null, interviewPrivate: null, archived: false, role: null });
    if (s.project && !s.sharedId) {
      useLive.getState().resumeOwned(s.project.id);
      showKeptInterview();
    }
  });

  // When a session goes (ended, closed while away), the interview stays on screen from what was kept.
  useLive.subscribe((s, prev) => {
    if (!s.interview && (prev.interview || s.status !== prev.status)) showKeptInterview();
  });

  // Runs started here are shown to everyone else in the session.
  useExecution.subscribe((s) => {
    const run = s.run;
    if (!session || !run?.id || run.watchedBy || session.announced.has(run.id)) return;
    if (run.projectId !== session.projectId || useLive.getState().role === "viewer") return;
    session.announced.add(run.id);
    session.client.send({ type: "run", executionId: run.id, mode: run.mode === "test" ? "run" : run.mode, entry: run.entry, interactive: run.interactive });
  });

  // Test runs too: everyone sees the results arrive in their Tests panel.
  useTests.subscribe((s, prev) => {
    if (!session || !s.runId || s.runId === prev.runId || s.watchedBy || session.announced.has(s.runId)) return;
    if (useWorkspace.getState().project?.id !== session.projectId || useLive.getState().role === "viewer") return;
    session.announced.add(s.runId);
    session.client.send({ type: "run", executionId: s.runId, mode: "test", entry: "", tests: s.runTestIds });
  });

  watchedInput.send = (executionId, data, eof) => session?.client.send({ type: "input", executionId, data, eof }) ?? false;

  window.addEventListener("online", () => session?.client.retryNow());
}

