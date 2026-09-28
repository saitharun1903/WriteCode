import type { ExecutionResult } from "../execution/types.js";

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
  /** Set when the project was started from a built-in example (its id). */
  example?: string;
  createdAt: number;
  updatedAt: number;
  /** When the project was last run or debugged. Unset until its first run. */
  lastRunAt?: number;
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
  createdAt: number;
}

export interface Snapshot {
  id: string;
  projectId: string;
  label: string;
  files: ProjectFile[];
  createdAt: number;
}
