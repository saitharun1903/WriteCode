"use client";

import { create } from "zustand";
import { getLanguage, isWithin, rebase, type InterviewRecord, type Project, type ProjectSummary, type TestCase } from "@cw/shared";
import { toast } from "@/components/ui/toast";
import { createId } from "@/lib/id";
import { historyRepo, projectRepo } from "./db";
import { applyImport, type PlannedFile } from "./import";
import { useSettings } from "@/features/settings/store";
import * as ops from "./operations";

type SaveState = "saved" | "pending" | "saving" | "error";

interface WorkspaceState {
  status: "loading" | "ready" | "error";
  loadError?: string;
  projects: ProjectSummary[];
  project: Project | null;
  openTabs: string[];
  activeFile: string | null;
  saveState: SaveState;
  /** In a live session as view-only: nothing in the project can be changed. */
  readOnly: boolean;
  /** Id of a project that belongs to someone else's live session: kept in memory only. */
  sharedId: string | null;

  init: () => Promise<void>;
  createProject: (languageId: string, name?: string) => Promise<void>;
  openProject: (id: string) => Promise<void>;
  closeProject: () => void;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<void>;
  /** Replaces the current project's files (restore from history/snapshot). */
  replaceFiles: (files: Project["files"], entryFile?: string) => void;

  openFile: (path: string) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  cycleTab: (delta: number) => void;
  updateFile: (path: string, content: string) => void;
  createFile: (dir: string, name: string) => string | null;
  createFolder: (dir: string, name: string) => string | null;
  renamePath: (path: string, newName: string) => string | null;
  movePath: (from: string, toDir: string) => void;
  deletePath: (path: string) => void;
  setEntryFile: (path: string) => void;
  toggleBreakpoint: (file: string, line: number) => void;
  setBreakpoints: (file: string, lines: number[]) => void;
  clearBreakpoints: () => void;
  setStdin: (stdin: string) => void;
  setTests: (tests: TestCase[]) => void;
  /** Keeps an interview with the project it was given in, so it can be opened again later. */
  setInterviewRecord: (record: InterviewRecord) => void;
  /** Adds imported files, replacing same-named ones, and opens the first new source file. */
  importFiles: (files: PlannedFile[]) => void;
  /** Records that the open project was run or debugged, which makes it recent work. */
  markRun: () => void;
  flush: () => Promise<void>;
  /** Opens someone else's live project without saving it. */
  openShared: (project: Project) => void;
  /** Applies changes that came from other people in a live session. */
  applyShared: (patch: Pick<Project, "files" | "folders" | "entryFile" | "stdin" | "name" | "tests">) => void;
  /**
   * Saves the open (shared) project as a project of your own; or `source`,
   * a project that is no longer open, under `name`.
   */
  saveCopy: (source?: Project, name?: string) => Promise<Project | null>;
  setReadOnly: (readOnly: boolean) => void;
}

const LAST_PROJECT_KEY = "cw:last-project";
/** When this browser last had the site open (ms), written while it is open and as it closes. */
const LAST_SEEN_KEY = "cw:last-seen";
/**
 * Coming back within this long (a reload, a tab closed by mistake) reopens the
 * project that was open; after it, the site starts from the start screen.
 */
export const RESUME_WITHIN_MS = 10 * 60_000;
const tabsKey = (id: string) => `cw:tabs:${id}`;
const SAVE_DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
/** Incremented on every project switch so late async loads cannot clobber a newer choice. */
let openToken = 0;

let seenTimer: ReturnType<typeof setInterval> | null = null;

/** Notes that the site is open now, and keeps noting it until the page goes. */
function keepSeen() {
  const mark = () => writeJSON(LAST_SEEN_KEY, Date.now());
  mark();
  if (seenTimer || typeof window === "undefined") return;
  seenTimer = setInterval(mark, 20_000);
  window.addEventListener("pagehide", mark);
  document.addEventListener("visibilitychange", mark);
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: tab layout is a convenience, not data.
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Applies a project mutation, updates the listing and schedules a debounced save. */
  const commit = (project: Project) => {
    // A shared project is someone else's: it lives in memory until the user saves a copy.
    if (project.id === get().sharedId) return void set({ project, saveState: "saved" });
    set((s) => ({
      project,
      saveState: "pending",
      projects: s.projects.map((p) => (p.id === project.id ? ops.summarize(project) : p)),
    }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flush(), SAVE_DEBOUNCE_MS);
  };

  const persistTabs = () => {
    const { project, openTabs, activeFile } = get();
    if (project) writeJSON(tabsKey(project.id), { openTabs, activeFile });
  };

  /** True (and says why) when the project cannot be changed: view-only in a live session. */
  const blocked = () => {
    if (!get().readOnly) return false;
    toast.info("View only", "The owner of this live session has not given you edit access.");
    return true;
  };

  /** Runs a pure operation and reports user errors as toasts instead of throwing. */
  const attempt = <T,>(fn: () => T): T | null => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ops.ProjectOperationError) toast.error(e.message);
      else toast.error("Operation failed", errorMessage(e));
      return null;
    }
  };

  /** Deletes a project the user only opened (never ran, never changed) once they leave it. */
  const discardIfUntouched = async (project: Project | null) => {
    if (!project || project.id === get().sharedId || !ops.summarize(project).untouched || get().project?.id === project.id) return;
    try {
      await projectRepo.delete(project.id);
      localStorage.removeItem(tabsKey(project.id));
    } catch {
      // Best effort: an untouched project is harmless if it lingers.
    }
    set((s) => ({ projects: s.projects.filter((p) => p.id !== project.id) }));
  };

  /** `opened`: the user opened or created it now (not restored after a reload). */
  const loadProject = (project: Project, opened = true) => {
    const saved = readJSON<{ openTabs: string[]; activeFile: string | null }>(tabsKey(project.id));
    const exists = (p: string) => project.files.some((f) => f.path === p);
    let openTabs = saved?.openTabs.filter(exists) ?? [];
    let activeFile = saved?.activeFile && exists(saved.activeFile) ? saved.activeFile : null;
    if (openTabs.length === 0 && exists(project.entryFile)) openTabs = [project.entryFile];
    activeFile ??= openTabs[0] ?? null;
    set({ project, openTabs, activeFile, saveState: "saved", sharedId: null, readOnly: false });
    writeJSON(LAST_PROJECT_KEY, project.id);
    // A project the user opens starts on its code; Run, Debug, Visualize and Tests open the bottom
    // panel when used. Restoring the last project after a reload keeps the layout as it was.
    if (opened) useSettings.getState().updateLayout({ bottomOpen: false });
  };

  /** Saves a newly created project, lists it and opens it in place of the current one. */
  const startProject = async (project: Project) => {
    try {
      await projectRepo.put(project);
    } catch (e) {
      return void toast.error("Could not create project", errorMessage(e));
    }
    const previous = get().project;
    set((s) => ({ projects: [ops.summarize(project), ...s.projects] }));
    loadProject(project);
    await discardIfUntouched(previous);
  };

  return {
    status: "loading",
    projects: [],
    project: null,
    openTabs: [],
    activeFile: null,
    saveState: "saved",
    readOnly: false,
    sharedId: null,

    init() {
      // Idempotent: React StrictMode and remounts may call this more than once.
      initPromise ??= (async () => {
        // Ask the browser not to evict our IndexedDB data under storage pressure,
        // so projects and history stay until the user deletes them.
        void navigator.storage?.persist?.().catch(() => false);
        try {
          // Projects saved before run tracking: take their last run from history.
          const runs = await historyRepo.lastRunByProject().catch(() => new Map<string, number>());
          for (const summary of await projectRepo.list()) {
            const ranAt = runs.get(summary.id);
            if (summary.lastRunAt || !ranAt) continue;
            const stored = await projectRepo.get(summary.id);
            if (stored) await projectRepo.put({ ...stored, lastRunAt: ranAt });
          }
          let last = readJSON<string>(LAST_PROJECT_KEY);
          // Away for a while: start from the start screen, not from where it was left.
          const seen = readJSON<number>(LAST_SEEN_KEY);
          if (last && !(typeof seen === "number" && Date.now() - seen <= RESUME_WITHIN_MS)) {
            last = null;
            try {
              localStorage.removeItem(LAST_PROJECT_KEY);
            } catch {}
          }
          keepSeen();
          // Projects that were only opened and then left are not kept.
          let projects = await projectRepo.list();
          for (const p of projects) if (p.untouched && p.id !== last) await projectRepo.delete(p.id);
          projects = projects.filter((p) => !p.untouched || p.id === last);
          if (last && projects.some((p) => p.id === last)) {
            const project = await projectRepo.get(last);
            if (project) loadProject(project, false);
          }
          set({ projects, status: "ready" });
        } catch (e) {
          set({ status: "error", loadError: errorMessage(e) });
        }
      })();
      return initPromise;
    },

    async createProject(languageId, name) {
      const lang = getLanguage(languageId);
      if (!lang) return void toast.error(`Unknown language: ${languageId}`);
      await get().flush();
      openToken++;
      const project = ops.createProject(createId(), name ?? `${lang.name} project`, languageId);
      await startProject(project);
    },


    async openProject(id) {
      const token = ++openToken;
      await get().flush();
      const previous = get().project;
      try {
        const project = await projectRepo.get(id);
        if (token !== openToken) return;
        if (!project) return void toast.error("Project not found", "It may have been deleted in another tab.");
        loadProject(project);
        await discardIfUntouched(previous);
      } catch (e) {
        toast.error("Could not open project", errorMessage(e));
      }
    },

    closeProject() {
      openToken++;
      const previous = get().project;
      void get()
        .flush()
        .then(() => discardIfUntouched(previous));
      set({ project: null, openTabs: [], activeFile: null, sharedId: null, readOnly: false });
      try {
        localStorage.removeItem(LAST_PROJECT_KEY);
      } catch {}
    },

    markRun() {
      const project = get().project;
      if (project) commit({ ...project, lastRunAt: Date.now() });
    },

    async renameProject(id, name) {
      const trimmed = name.trim();
      if (!trimmed) return void toast.error("Project name cannot be empty.");
      const current = get().project;
      if (current?.id === id) return commit({ ...current, name: trimmed, updatedAt: Date.now() });
      let next: Project;
      try {
        const stored = await projectRepo.get(id);
        if (!stored) return;
        next = { ...stored, name: trimmed, updatedAt: Date.now() };
        await projectRepo.put(next);
      } catch (e) {
        return void toast.error("Could not rename project", errorMessage(e));
      }
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? ops.summarize(next) : p)) }));
    },

    async deleteProject(id) {
      try {
        await projectRepo.delete(id);
      } catch (e) {
        return void toast.error("Could not delete project", errorMessage(e));
      }
      try {
        localStorage.removeItem(tabsKey(id));
      } catch {}
      if (get().project?.id === id) {
        if (saveTimer) clearTimeout(saveTimer);
        set({ project: null, openTabs: [], activeFile: null, saveState: "saved" });
      }
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
    },

    async duplicateProject(id) {
      await get().flush();
      let copy: Project;
      try {
        const source = await projectRepo.get(id);
        if (!source) return;
        copy = ops.duplicateProject(source, createId(), get().projects.map((p) => p.name));
        await projectRepo.put(copy);
      } catch (e) {
        return void toast.error("Could not duplicate project", errorMessage(e));
      }
      set((s) => ({ projects: [ops.summarize(copy), ...s.projects] }));
      toast.success(`Created "${copy.name}"`);
    },

    replaceFiles(files, entryFile) {
      const project = get().project;
      if (!project) return;
      if (blocked()) return;
      const entry = entryFile && files.some((f) => f.path === entryFile) ? entryFile : project.entryFile;
      commit({ ...project, files: structuredClone(files), entryFile: entry, updatedAt: Date.now() });
      const exists = (p: string) => files.some((f) => f.path === p);
      const openTabs = get().openTabs.filter(exists);
      const activeFile = get().activeFile && exists(get().activeFile!) ? get().activeFile : (openTabs[0] ?? entry);
      set({ openTabs: openTabs.length ? openTabs : [entry], activeFile });
      persistTabs();
    },

    openFile(path) {
      const { openTabs } = get();
      set({ activeFile: path, openTabs: openTabs.includes(path) ? openTabs : [...openTabs, path] });
      persistTabs();
    },

    closeTab(path) {
      const { openTabs, activeFile } = get();
      const idx = openTabs.indexOf(path);
      if (idx === -1) return;
      const next = openTabs.filter((t) => t !== path);
      set({
        openTabs: next,
        activeFile: activeFile === path ? (next[Math.min(idx, next.length - 1)] ?? null) : activeFile,
      });
      persistTabs();
    },

    closeOtherTabs(path) {
      set({ openTabs: [path], activeFile: path });
      persistTabs();
    },

    cycleTab(delta) {
      const { openTabs, activeFile } = get();
      if (openTabs.length < 2 || !activeFile) return;
      const idx = openTabs.indexOf(activeFile);
      set({ activeFile: openTabs[(idx + delta + openTabs.length) % openTabs.length]! });
      persistTabs();
    },

    updateFile(path, content) {
      const project = get().project;
      if (!project) return;
      if (blocked()) return;
      const next = ops.updateFileContent(project, path, content);
      if (next !== project) commit(next);
    },

    createFile(dir, name) {
      const project = get().project;
      if (!project) return null;
      if (blocked()) return null;
      const res = attempt(() => ops.addFile(project, dir, name));
      if (!res) return null;
      commit(res.project);
      get().openFile(res.path);
      return res.path;
    },

    createFolder(dir, name) {
      const project = get().project;
      if (!project) return null;
      if (blocked()) return null;
      const res = attempt(() => ops.addFolder(project, dir, name));
      if (!res) return null;
      commit(res.project);
      return res.path;
    },

    renamePath(path, newName) {
      const project = get().project;
      if (!project) return null;
      if (blocked()) return null;
      const res = attempt(() => ops.renamePath(project, path, newName));
      if (!res) return null;
      commit(res.project);
      set((s) => ({
        openTabs: s.openTabs.map((t) => rebase(t, path, res.path)),
        activeFile: s.activeFile ? rebase(s.activeFile, path, res.path) : null,
      }));
      persistTabs();
      return res.path;
    },

    movePath(from, toDir) {
      const project = get().project;
      if (!project) return;
      if (blocked()) return;
      const to = toDir ? `${toDir}/${ops.basename(from)}` : ops.basename(from);
      if (to === from) return;
      const res = attempt(() => ops.movePath(project, from, to));
      if (!res) return;
      commit(res.project);
      set((s) => ({
        openTabs: s.openTabs.map((t) => rebase(t, from, res.path)),
        activeFile: s.activeFile ? rebase(s.activeFile, from, res.path) : null,
      }));
      persistTabs();
    },

    deletePath(path) {
      const project = get().project;
      if (!project) return;
      if (blocked()) return;
      commit(ops.deletePath(project, path));
      const { openTabs, activeFile } = get();
      const next = openTabs.filter((t) => !isWithin(t, path));
      set({ openTabs: next, activeFile: activeFile && isWithin(activeFile, path) ? (next[0] ?? null) : activeFile });
      persistTabs();
    },

    setEntryFile(path) {
      if (get().readOnly) return;
      const project = get().project;
      if (project && project.entryFile !== path) commit({ ...project, entryFile: path, updatedAt: Date.now() });
    },

    toggleBreakpoint(file, line) {
      const project = get().project;
      if (project) commit(ops.toggleBreakpoint(project, file, line));
    },

    setBreakpoints(file, lines) {
      const project = get().project;
      if (!project) return;
      const next = ops.setBreakpoints(project, file, lines);
      if (next !== project) commit(next);
    },

    clearBreakpoints() {
      const project = get().project;
      if (project && project.breakpoints && Object.keys(project.breakpoints).length) {
        commit({ ...project, breakpoints: {}, updatedAt: Date.now() });
      }
    },

    importFiles(files) {
      const project = get().project;
      if (!project || !files.length) return;
      if (blocked()) return;
      commit(applyImport(project, files));
      const lang = getLanguage(project.language);
      const first = files.find((f) => lang?.extensions.some((e) => f.path.toLowerCase().endsWith(e))) ?? files[0]!;
      get().openFile(first.path);
    },

    setTests(tests) {
      if (blocked()) return;
      const project = get().project;
      if (project && project.tests !== tests) commit({ ...project, tests, updatedAt: Date.now() });
    },

    setInterviewRecord(record) {
      const project = get().project;
      // Only the interviewer's own project: a candidate's copy is never kept.
      if (!project || project.id === get().sharedId) return;
      commit({ ...project, interview: record, updatedAt: Math.max(project.updatedAt, record.savedAt) });
    },

    setStdin(stdin) {
      if (blocked()) return;
      const project = get().project;
      if (project && project.stdin !== stdin) commit({ ...project, stdin, updatedAt: Date.now() });
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const { project, saveState } = get();
      if (!project || saveState === "saved" || project.id === get().sharedId) return;
      set({ saveState: "saving" });
      try {
        await projectRepo.put(project);
        // Only mark saved if nothing changed while the write was in flight.
        if (get().project === project) set({ saveState: "saved" });
      } catch (e) {
        set({ saveState: "error" });
        toast.error("Autosave failed", errorMessage(e));
      }
    },

    openShared(project) {
      openToken++;
      const previous = get().project;
      void get()
        .flush()
        .then(() => discardIfUntouched(previous));
      const openTabs = project.files.some((f) => f.path === project.entryFile) ? [project.entryFile] : project.files.slice(0, 1).map((f) => f.path);
      set({ project, openTabs, activeFile: openTabs[0] ?? null, saveState: "saved", sharedId: project.id, readOnly: false });
      useSettings.getState().updateLayout({ bottomOpen: false });
    },

    applyShared(patch) {
      const project = get().project;
      if (!project) return;
      const next = { ...project, ...patch, updatedAt: Date.now() };
      commit(next);
      // Tabs of files someone else deleted or renamed close.
      const exists = (p: string) => next.files.some((f) => f.path === p);
      const openTabs = get().openTabs.filter(exists);
      const activeFile = get().activeFile;
      if (openTabs.length !== get().openTabs.length || (activeFile && !exists(activeFile))) {
        set({ openTabs, activeFile: activeFile && exists(activeFile) ? activeFile : (openTabs[0] ?? null) });
        persistTabs();
      }
    },

    async saveCopy(source, name) {
      const project = source ?? get().project;
      if (!project) return null;
      const names = get().projects.map((p) => p.name);
      // Saved on purpose, so it counts as recent work.
      const copy = { ...ops.duplicateProject(project, createId(), names), lastRunAt: Date.now() };
      if (name) {
        copy.name = name;
        for (let i = 2; names.includes(copy.name); i++) copy.name = `${name} ${i}`;
      }
      try {
        await projectRepo.put(copy);
      } catch (e) {
        toast.error("Could not save a copy", errorMessage(e));
        return null;
      }
      set((s) => ({ projects: [ops.summarize(copy), ...s.projects] }));
      return copy;
    },

    setReadOnly: (readOnly) => set({ readOnly }),
  };
});

// Dev/test hook for inspecting workspace state from the browser console and E2E tests.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __cwWorkspace: typeof useWorkspace }).__cwWorkspace = useWorkspace;
}
