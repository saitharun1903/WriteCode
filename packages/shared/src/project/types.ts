import type { ExecutionResult } from "../execution/types.js";
import type { InterviewRecord, InterviewVerdict } from "../live/interview.js";

export interface ProjectFile {
  /** Relative path using `/` separators, e.g. `src/Main.java`. */
  path: string;
  content: string;
}

/** A saved input with the output the program should print for it. */
export interface TestCase {
  id: string;
  input: string;
  /** Empty: no expectation, the test only shows what the program printed. */
  expected: string;
}

export interface Project {
  id: string;
  name: string;
  /**
   * A temporary project lives only in the open page: it is never saved, keeps
   * no run history, and is gone when it is closed or the page goes.
   */
  temporary?: boolean;
  language: string;
  entryFile: string;
  files: ProjectFile[];
  /** Explicit folders so empty folders survive. Parent folders of files are implied. */
  folders: string[];
  stdin: string;
  /** Debugger breakpoints: file path -> sorted 1-based lines. Optional for projects saved before debugging existed. */
  breakpoints?: Record<string, number[]>;
  /** Test cases, run together from the Tests tool window. Optional for projects saved before tests existed. */
  tests?: TestCase[];
  createdAt: number;
  updatedAt: number;
  /** When the project was last run or debugged. Unset until its first run. */
  lastRunAt?: number;
  /** The project is an interview this browser gave: what happened in it. */
  interview?: InterviewRecord;
}

/** An interview in the start screen's list. */
export interface InterviewSummary {
  title: string;
  candidate?: string;
  durationMin: number;
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  /** The latest submission (the code handed in, once it has ended). */
  verdict?: InterviewVerdict;
  /** Things to look at: times the candidate left the window, and paste attempts. */
  flags: number;
}

/** Lightweight listing entry used by the start screen without loading file contents. */
export interface ProjectSummary {
  id: string;
  name: string;
  language: string;
  fileCount: number;
  updatedAt: number;
  lastRunAt?: number;
  /**
   * Never run, and its files are still exactly the language template: the
   * project was only opened. Such projects are not listed as recent work and
   * are discarded when the user leaves them.
   */
  untouched: boolean;
  /** Set for interviews, which are listed apart from other projects. */
  interview?: InterviewSummary;
}

export interface HistoryEntry {
  id: string;
  projectId: string;
  projectName: string;
  language: string;
  entryFile: string;
  files: ProjectFile[];
  stdin: string;
  result: ExecutionResult;
  /** When this code last ran. */
  createdAt: number;
  /** How many times this same code has run (absent: once). The entry holds the latest run. */
  runs?: number;
  /** When this code first ran (absent: `createdAt`). */
  firstRunAt?: number;
}

export interface Snapshot {
  id: string;
  projectId: string;
  label: string;
  files: ProjectFile[];
  createdAt: number;
}
