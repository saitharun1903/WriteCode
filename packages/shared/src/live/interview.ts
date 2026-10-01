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
  /** Sample tests: the candidate sees them and runs them. */
  maxSampleTests: 6,
  /** Verdicts of earlier submissions the candidate can look back at. */
  maxVerdicts: 30,
  /** Output of one test kept with a submission, for the interviewer. */
  submissionOutputChars: 4000,
  /** Shortest time between two submissions. */
  submitCooldownMs: 3000,
  /** Leaving the window: reports closer together than this are one time (Alt+Tab also leaves full screen). */
  leaveWindowMs: 2000,
  /** Times the candidate may leave the window before the interview ends, unless the interviewer chose otherwise. */
  defaultMaxLeaves: 3,
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
  /** One camera-connection message (a session description is a few kilobytes). */
  maxRtcBytes: 32 * 1024,
  /** After the interview ends, the candidate stays this long (to see the final check) before the session closes for them. */
  closeAfterEndMs: 20_000,
} as const;

export interface InterviewTest {
  id: string;
  input: string;
  expected: string;
  /** What the test checks, for the interviewer (e.g. "1 is not prime"). */
  note?: string;
}

/** What the interviewer prepares. The statement is plain text (line breaks kept). */
export interface InterviewSetup {
  title: string;
  statement: string;
  durationMin: number;
  /** Shown to the candidate with the problem; Run checks the code against them. */
  samples?: InterviewTest[];
  hiddenTests: InterviewTest[];
  /** The interview ends when the candidate has left the window this many times. 0: only recorded. */
  maxLeaves?: number;
}

export type InterviewVerdictStatus = "accepted" | "wrong-answer" | "runtime-error" | "time-limit" | "compile-error" | "error";

/**
 * How a submission did on every test, as the candidate sees it: the score and
 * which test failed first, never a hidden test's input or expected output.
 */
export interface InterviewVerdict {
  /** Server time, ms. */
  at: number;
  status: InterviewVerdictStatus;
  passed: number;
  total: number;
  /** The first test that did not pass: a sample (which the candidate can look at) or a hidden one. */
  firstFailed?: { kind: "sample" | "hidden"; number: number };
  /** Compiler output, when the code did not compile. */
  compileOutput?: string;
  /** Why the submission could not be checked. */
  message?: string;
  /** Slowest test, ms. */
  timeMs?: number;
  /** Most memory the program used, bytes, when the sandbox reports it. */
  memoryBytes?: number;
  /** Judged when the interview ended, not by the candidate pressing Submit. */
  final?: boolean;
}

/** One test of a submission, for the interviewer. */
export interface InterviewSubmissionTest {
  id: string;
  kind: "sample" | "hidden";
  verdict: "passed" | "failed" | "ran" | "time-limit" | "crashed" | "error";
  status: string;
  /** Cut to INTERVIEW_LIMITS.submissionOutputChars. */
  stdout: string;
  stderr: string;
  executionTime?: number;
}

export interface InterviewSubmission {
  at: number;
  by?: string;
  verdict: InterviewVerdict;
  tests: InterviewSubmissionTest[];
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
  /** Why it ended, in words ("Time is up", "Asha finished"…). */
  endReason?: string;
  /** Name of the candidate, once one has joined. */
  candidate?: string;
  samples?: InterviewTest[];
  /** 0: leaving the window is only recorded. */
  maxLeaves?: number;
  /** Times the candidate has left the window (tab, another window, full screen). */
  leaves?: number;
  /** A submission is being checked. */
  judging?: boolean;
  /** Submissions so far, oldest first. */
  verdicts?: InterviewVerdict[];
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
  | "camera-on"
  | "camera-off"
  | "submit"
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
  /** The latest submission, test by test. */
  submission?: InterviewSubmission;
}

/** Events a candidate's browser may report about itself. */
export const CANDIDATE_EVENTS = new Set<InterviewEventKind>(["consent", "tab-hidden", "tab-visible", "blur", "focus", "fullscreen-exit", "fullscreen-enter", "paste", "camera-on", "camera-off"]);

/** Checks and trims a setup sent by a browser; null when unusable. */
export function cleanInterviewSetup(raw: unknown): InterviewSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const minutes = Math.round(Number(r.durationMin));
  if (!Number.isFinite(minutes)) return null;
  const tests = (list: unknown, max: number): InterviewTest[] =>
    (Array.isArray(list) ? list : []).slice(0, max).flatMap((t) => {
      if (!t || typeof t !== "object") return [];
      const x = t as Record<string, unknown>;
      const id = typeof x.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) ? x.id : null;
      const note = text(x.note, 160).trim();
      return id ? [{ id, input: text(x.input, 128 * 1024), expected: text(x.expected, 128 * 1024), ...(note ? { note } : {}) }] : [];
    });
  const leaves = Math.round(Number(r.maxLeaves));
  return {
    title: text(r.title, INTERVIEW_LIMITS.maxTitleChars).trim() || "Coding interview",
    statement: text(r.statement, INTERVIEW_LIMITS.maxStatementChars),
    durationMin: Math.min(INTERVIEW_LIMITS.maxMinutes, Math.max(INTERVIEW_LIMITS.minMinutes, minutes)),
    // Notes on sample tests are the interviewer's; the candidate sees the tests.
    ...(r.samples !== undefined ? { samples: tests(r.samples, INTERVIEW_LIMITS.maxSampleTests).map(({ id, input, expected }) => ({ id, input, expected })) } : {}),
    hiddenTests: tests(r.hiddenTests, INTERVIEW_LIMITS.maxHiddenTests),
    maxLeaves: Number.isFinite(leaves) && leaves >= 0 && leaves <= 20 ? leaves : INTERVIEW_LIMITS.defaultMaxLeaves,
  };
}

/** A complexity estimate for the interviewer. Always an estimate: exact analysis of any program is impossible. */
export interface ComplexityEstimate {
  time: string;
  space: string;
  explanation: string;
  /** The technique the code uses, in a few words ("Hash table", "Two nested loops"). */
  approach?: string;
  /** The technique a strong solution uses; the same as `approach` when the code is already there. */
  suggested?: string;
  /** The idea that makes the suggested approach work, one sentence. */
  keyIdea?: string;
  /** A follow-up question the interviewer can ask. */
  consider?: string;
}

/**
 * An interview as the interviewer's browser keeps it with the project, so it
 * can be opened again (overview, report, replay) after its session has closed.
 */
export interface InterviewRecord {
  public: InterviewPublic;
  private: InterviewPrivate;
  /** The typing history for replay (document updates with their times, base64), once the interview has ended. */
  history?: [number, string][];
  analysis?: ComplexityEstimate;
  savedAt: number;
}

export type ProblemDifficulty = "easy" | "medium" | "hard";

/**
 * A problem written from a short topic. The expected outputs are computed by
 * running `solution` in the sandbox (and checked against `brute` on the small
 * inputs), never taken on trust.
 */
export interface GeneratedProblem {
  title: string;
  /** Plain text: task, Input, Output, Constraints. */
  statement: string;
  samples: { input: string; note: string }[];
  /** Small inputs aimed at the usual mistakes. */
  edge: { input: string; note: string }[];
  /** Efficient Python 3 reference solution. */
  solution: string;
  /** Simple, obviously correct Python 3 solution, for cross-checking. */
  brute: string;
  /** Python 3 program: asserts that an input follows the format and constraints. */
  validator: string;
  /** Python 3 program: reads a size, prints one random valid input of that size. */
  generator: string;
  /** Sizes for the generator, increasing. */
  sizes: number[];
}
