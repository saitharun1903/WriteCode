/**
 * Live sessions: several people edit one project at the same time and see each
 * other's cursors, runs and debug position.
 *
 * Transport: one WebSocket per participant on `/ws-live`; the first message
 * (`join`) names the session, so its id never appears in a URL or access log.
 * - Binary frames carry Yjs (the shared document) and cursor presence: the
 *   first byte is a LiveFrame, the rest a y-protocols message.
 * - Text frames carry JSON control messages (LiveClientMessage /
 *   LiveServerMessage): joining, roles, removing people, ending the session and
 *   announcing runs.
 *
 * The shared document holds the project:
 * - `meta` (Y.Map): `name`, `language`, `entryFile`, `stdin`, `ready`
 * - `files` (Y.Map<Y.Text>): path → content
 * - `folders` (Y.Map<true>): explicit (possibly empty) folders
 * - `tests` (Y.Map<Y.Map>): test id → { input: Y.Text, expected: Y.Text }
 * - `testOrder` (Y.Array<string>): the order tests are listed in
 */

import type { InterviewEvent, InterviewPrivate, InterviewPublic, InterviewSetup } from "./interview.js";

export type LiveRole = "owner" | "editor" | "viewer";
/** What people who open the link can do. */
export type LiveJoinRole = Exclude<LiveRole, "owner">;

export const LiveFrame = { sync: 0, awareness: 1 } as const;

export const LIVE_LIMITS = {
  /** People in one session at once, owner included. */
  maxParticipants: 100,
  /** Sessions one client may have in use at once (used within `activeWindowSeconds`). */
  maxRoomsPerClient: 10,
  activeWindowSeconds: 2 * 60 * 60,
  /** Size of the shared document (all files), bytes. */
  maxDocBytes: 3 * 1024 * 1024,
  /** One WebSocket frame, bytes. The first sync of a large project is the biggest. */
  maxFrameBytes: 4 * 1024 * 1024,
  /** Frames per connection per second (typing sends about one per key). */
  maxFramesPerSecond: 120,
  /** Presence (cursor, name) per person, bytes. */
  maxAwarenessBytes: 2048,
  maxNameLength: 40,
  /**
   * A session whose owner has been gone this long closes by itself: nobody is
   * left to answer for what is shared. (An interview ends instead, and is kept
   * for the interviewer's report.)
   */
  ownerAwaySeconds: 10 * 60,
  /** A session nobody has used for this long is removed. */
  idleTtlSeconds: 24 * 60 * 60,
} as const;

/** Room ids are 144 random bits: whoever has the link can join, so it must not be guessable. */
export const LIVE_ROOM_ID = /^[A-Za-z0-9_-]{24}$/;
export const isLiveRoomId = (id: unknown): id is string => typeof id === "string" && LIVE_ROOM_ID.test(id);

/** Per-browser key so the owner's choices (role, removal) stick to a person across reconnects. */
export const LIVE_CLIENT_KEY = /^[A-Za-z0-9_-]{16,64}$/;

/** Cursor and label colours, readable on dark and light editor themes. */
export const LIVE_COLORS = ["#e5484d", "#3e8ef7", "#30a46c", "#f5a524", "#8e4ec6", "#12a594", "#e93d82", "#d6780f"] as const;

export interface LiveParticipant {
  /** Connection id, unique within the room. */
  id: string;
  name: string;
  role: LiveRole;
  /** Index into LIVE_COLORS. */
  color: number;
}

/** Someone started a run, debug session or visualization that everyone can watch. */
export interface LiveRunNotice {
  executionId: string;
  mode: "run" | "debug" | "visualize" | "test";
  entry: string;
  by: { id: string; name: string };
  /** The program reads what people type while it runs; anyone who can edit may type it. */
  interactive?: boolean;
  /** Test runs: ids of the tests run, in the order their results arrive. */
  tests?: string[];
}

export type LiveClientMessage =
  | { type: "join"; room: string; name: string; clientKey: string; ownerToken?: string }
  | { type: "rename"; name: string }
  | { type: "set-role"; id: string; role: LiveJoinRole }
  | { type: "default-role"; role: LiveJoinRole }
  | { type: "remove"; id: string }
  | { type: "end" }
  | { type: "run"; executionId: string; mode: LiveRunNotice["mode"]; entry: string; interactive?: boolean; tests?: string[] }
  /** Typed input for a run someone in the session started. */
  | { type: "input"; executionId: string; data: string; eof?: boolean }
  // ---- Interview mode (see ./interview.ts).
  /** Interviewer: the problem, duration and hidden tests (hidden tests may change during the interview). */
  | { type: "interview-setup"; setup: InterviewSetup }
  /** Interviewer: add minutes to the clock. */
  | { type: "interview-extend"; minutes: number }
  /** Interviewer ends the interview, or the candidate finishes early. */
  | { type: "interview-end" }
  /** Candidate: check the code against every test (samples and hidden). The verdict arrives in the interview state. */
  | { type: "interview-submit" }
  | { type: "interview-notes"; notes: string; rating: number }
  /** Candidate: what happened in their browser (tab switch, paste…). Interviewer: a run's outcome. */
  | { type: "interview-event"; event: Pick<InterviewEvent, "kind" | "detail" | "chars"> }
  /** Interviewer: the typing history, for replay. */
  | { type: "interview-history" };

export type LiveServerMessage =
  | {
      type: "welcome";
      you: LiveParticipant;
      defaultRole: LiveJoinRole;
      participants: LiveParticipant[];
      run?: LiveRunNotice;
      /** Interview sessions: the problem and clock, for everyone. */
      interview?: InterviewPublic;
      /** Interview sessions, owner only: hidden tests, notes, the activity log. */
      interviewPrivate?: InterviewPrivate;
    }
  | { type: "participants"; participants: LiveParticipant[] }
  | { type: "role"; role: LiveRole }
  | { type: "default-role"; role: LiveJoinRole }
  | { type: "run"; run: LiveRunNotice }
  | { type: "input-error"; executionId: string; message: string }
  | { type: "interview"; state: InterviewPublic }
  | { type: "interview-private"; state: InterviewPrivate }
  | { type: "interview-event"; event: InterviewEvent }
  /** Every document update with its time (ms), base64, from the start of the session. */
  | { type: "interview-history"; updates: [number, string][] }
  | { type: "ended" }
  | { type: "removed" }
  | { type: "error"; code: "not-found" | "full" | "removed" | "invalid" | "too-large" | "rate"; message: string };

/** Presence each person publishes: who they are, which file they are in and where their cursor is. */
export interface LivePresence {
  user: { name: string; color: number; id: string };
  file?: string;
  /** Yjs relative positions (JSON) of the selection, so they stay correct while others type. */
  anchor?: unknown;
  head?: unknown;
  /** Where this person's debug session is paused, for everyone to see. */
  paused?: { file: string; line: number };
}

export const LIVE_ROLE_LABEL: Record<LiveRole, string> = { owner: "Owner", editor: "Can edit", viewer: "View only" };
