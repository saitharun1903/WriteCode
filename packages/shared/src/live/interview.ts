/**
 * Interview mode: a live session in which the owner is the interviewer and
 * everyone who joins is a candidate. Candidates get the editor, Run and the
 * sample tests only; the interviewer sees their code, runs, tab switches,
 * full-screen exits and pastes as they happen, runs hidden tests, keeps
 * private notes, and can replay how the code was written.
 *
 * What only the interviewer may see (hidden tests, notes, rating, the
 * activity log, the typing history) stays on the server and is sent to the
 * owner's connection only.
 */

export const INTERVIEW_LIMITS = {
  maxTitleChars: 120,
  maxStatementChars: 10_000,
  maxHiddenTests: 12,
  maxNotesChars: 10_000,
  /** Activity entries kept; older ones are dropped. */
  maxEvents: 2000,
  /** Typing history kept for replay (all document updates), bytes. */
  maxHistoryBytes: 8 * 1024 * 1024,
  /** How much of a paste the interviewer sees. */
  pastePreviewChars: 400,
  minMinutes: 5,
  maxMinutes: 240,
  /** Time the interviewer can add at once. */
  maxExtendMinutes: 60,
} as const;

export interface InterviewTest {
  id: string;
  input: string;
  expected: string;
}

/** What the interviewer prepares. The statement is plain text (line breaks kept). */
export interface InterviewSetup {
  title: string;
  statement: string;
  durationMin: number;
  hiddenTests: InterviewTest[];
}

/** Everyone sees this: the problem and the clock. */
export interface InterviewPublic {
  title: string;
  statement: string;
  durationMin: number;
  /** When the candidate agreed to the rules and the clock started. */
  startedAt?: number;
  endsAt?: number;
  /** The interview is over: candidates can no longer change the code. */
  endedAt?: number;
  /** Name of the candidate, once one has joined. */
  candidate?: string;
}

export type InterviewEventKind =
  | "joined"
  | "left"
  | "consent"
  | "started"
  | "tab-hidden"
  | "tab-visible"
  | "blur"
  | "focus"
  | "fullscreen-exit"
  | "fullscreen-enter"
  | "paste"
  | "run"
  | "run-result"
  | "blocked"
  | "extended"
  | "ended";

export interface InterviewEvent {
  /** Server time, ms. */
  t: number;
  kind: InterviewEventKind;
  /** Who it is about (a participant's name). */
  who?: string;
  /** Short description: the pasted text, the run status, the blocked tool… */
  detail?: string;
  /** Characters pasted. */
  chars?: number;
  /** How long the candidate was away (tab-visible, focus). */
  awayMs?: number;
}

/** Only the interviewer sees this. */
export interface InterviewPrivate {
  hiddenTests: InterviewTest[];
  notes: string;
  /** 0 = not rated, 1–5. */
  rating: number;
  events: InterviewEvent[];
}

/** Events a candidate's browser may report about itself. */
export const CANDIDATE_EVENTS = new Set<InterviewEventKind>(["consent", "tab-hidden", "tab-visible", "blur", "focus", "fullscreen-exit", "fullscreen-enter", "paste"]);

/** Checks and trims a setup sent by a browser; null when unusable. */
export function cleanInterviewSetup(raw: unknown): InterviewSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const minutes = Math.round(Number(r.durationMin));
  if (!Number.isFinite(minutes)) return null;
  const tests = Array.isArray(r.hiddenTests) ? r.hiddenTests : [];
  return {
    title: text(r.title, INTERVIEW_LIMITS.maxTitleChars).trim() || "Coding interview",
    statement: text(r.statement, INTERVIEW_LIMITS.maxStatementChars),
    durationMin: Math.min(INTERVIEW_LIMITS.maxMinutes, Math.max(INTERVIEW_LIMITS.minMinutes, minutes)),
    hiddenTests: tests.slice(0, INTERVIEW_LIMITS.maxHiddenTests).flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const x = t as Record<string, unknown>;
      const id = typeof x.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) ? x.id : null;
      return id ? [{ id, input: text(x.input, 128 * 1024), expected: text(x.expected, 128 * 1024) }] : [];
    }),
  };
}

/** A complexity estimate for the interviewer. Always an estimate: exact analysis of any program is impossible. */
export interface ComplexityEstimate {
  time: string;
  space: string;
  explanation: string;
}
