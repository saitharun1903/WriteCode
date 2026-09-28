"use client";

import { create } from "zustand";
import { getLanguage, isWithin, rebase, type Project, type ProjectSummary, type TestCase } from "@cw/shared";
import { toast } from "@/components/ui/toast";
import { createId } from "@/lib/id";
import { historyRepo, projectRepo } from "./db";
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
  /** Records that the open project was run or debugged, which makes it recent work. */
  markRun: () => void;
  flush: () => Promise<void>;
}

const LAST_PROJECT_KEY = "cw:last-project";
const tabsKey = (id: string) => `cw:tabs:${id}`;
const SAVE_DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
/** Incremented on every project switch so late async loads cannot clobber a newer choice. */
let openToken = 0;

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
    if (!project || !ops.summarize(project).untouched || get().project?.id === project.id) return;
    try {
      await projectRepo.delete(project.id);
      localStorage.removeItem(tabsKey(project.id));
    } catch {
      // Best effort: an untouched project is harmless if it lingers.
    }
    set((s) => ({ projects: s.projects.filter((p) => p.id !== project.id) }));
  };

  const loadProject = (project: Project) => {
    const saved = readJSON<{ openTabs: string[]; activeFile: string | null }>(tabsKey(project.id));
    const exists = (p: string) => project.files.some((f) => f.path === p);
    let openTabs = saved?.openTabs.filter(exists) ?? [];
    let activeFile = saved?.activeFile && exists(saved.activeFile) ? saved.activeFile : null;
    if (openTabs.length === 0 && exists(project.entryFile)) openTabs = [project.entryFile];
    activeFile ??= openTabs[0] ?? null;
    set({ project, openTabs, activeFile, saveState: "saved" });
    writeJSON(LAST_PROJECT_KEY, project.id);
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
          const last = readJSON<string>(LAST_PROJECT_KEY);
          // Projects that were only opened and then left are not kept.
          let projects = await projectRepo.list();
          for (const p of projects) if (p.untouched && p.id !== last) await projectRepo.delete(p.id);
          projects = projects.filter((p) => !p.untouched || p.id === last);
          if (last && projects.some((p) => p.id === last)) {
            const project = await projectRepo.get(last);
            if (project) loadProject(project);
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
      set({ project: null, openTabs: [], activeFile: null });
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
      const stored = await projectRepo.get(id);
      if (!stored) return;
      const next = { ...stored, name: trimmed, updatedAt: Date.now() };
      await projectRepo.put(next);
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
      const source = await projectRepo.get(id);
      if (!source) return;
      const copy = ops.duplicateProject(source, createId(), get().projects.map((p) => p.name));
      await projectRepo.put(copy);
      set((s) => ({ projects: [ops.summarize(copy), ...s.projects] }));
      toast.success(`Created "${copy.name}"`);
    },

    replaceFiles(files, entryFile) {
      const project = get().project;
      if (!project) return;
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
      const next = ops.updateFileContent(project, path, content);
      if (next !== project) commit(next);
    },

    createFile(dir, name) {
      const project = get().project;
      if (!project) return null;
      const res = attempt(() => ops.addFile(project, dir, name));
      if (!res) return null;
      commit(res.project);
      get().openFile(res.path);
      return res.path;
    },

    createFolder(dir, name) {
      const project = get().project;
      if (!project) return null;
      const res = attempt(() => ops.addFolder(project, dir, name));
      if (!res) return null;
      commit(res.project);
      return res.path;
    },

    renamePath(path, newName) {
      const project = get().project;
      if (!project) return null;
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
      commit(ops.deletePath(project, path));
      const { openTabs, activeFile } = get();
      const next = openTabs.filter((t) => !isWithin(t, path));
      set({ openTabs: next, activeFile: activeFile && isWithin(activeFile, path) ? (next[0] ?? null) : activeFile });
      persistTabs();
    },

    setEntryFile(path) {
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

    setTests(tests) {
      const project = get().project;
      if (project && project.tests !== tests) commit({ ...project, tests, updatedAt: Date.now() });
    },

    setStdin(stdin) {
      const project = get().project;
      if (project && project.stdin !== stdin) commit({ ...project, stdin, updatedAt: Date.now() });
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const { project, saveState } = get();
      if (!project || saveState === "saved") return;
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
  };
});

// Dev/test hook for inspecting workspace state from the browser console and E2E tests.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as unknown as { __cwWorkspace: typeof useWorkspace }).__cwWorkspace = useWorkspace;
}
