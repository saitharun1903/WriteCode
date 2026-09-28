"use client";

import { create } from "zustand";

export type ThemePreference = "dark" | "light" | "system";
/** Bottom tool windows. */
export type BottomTab = "run" | "debug" | "visualize" | "tests" | "problems" | "input";
const BOTTOM_TABS: readonly BottomTab[] = ["run", "debug", "visualize", "tests", "problems", "input"];
export type SideView = "explorer" | "search" | "history";

export interface Settings {
  theme: ThemePreference;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  /** Save an execution history entry for every run. */
  recordHistory: boolean;
  /** Add missing imports for well-known classes and modules while typing. */
  autoImport: boolean;
  /** Close brackets and quotes as they are typed. */
  autoClose: boolean;
  /** Show completion suggestions while typing (Ctrl+Space always works). */
  suggestions: boolean;
  /** Colour matching bracket pairs. */
  bracketColors: boolean;
  layout: {
    sidebarOpen: boolean;
    bottomOpen: boolean;
    sideView: SideView;
    bottomTab: BottomTab;
    assistantOpen: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  minimap: false,
  recordHistory: true,
  autoImport: true,
  autoClose: true,
  suggestions: true,
  bracketColors: false,
  layout: {
    sidebarOpen: true,
    bottomOpen: true,
    sideView: "explorer",
    bottomTab: "run",
    assistantOpen: false,
  },
};

const KEY = "cw:settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const layout = { ...DEFAULT_SETTINGS.layout, ...parsed.layout };
    // Older layouts used an "output" tab; unknown values fall back to Run.
    if (!BOTTOM_TABS.includes(layout.bottomTab)) layout.bottomTab = "run";
    // 13.5 was the previous default size; move it to the new default.
    if (parsed.fontSize === 13.5) parsed.fontSize = DEFAULT_SETTINGS.fontSize;
    return { ...DEFAULT_SETTINGS, ...parsed, layout };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface SettingsState extends Settings {
  hydrated: boolean;
  hydrate: () => void;
  update: (patch: Partial<Omit<Settings, "layout">>) => void;
  updateLayout: (patch: Partial<Settings["layout"]>) => void;
  resetLayout: () => void;
}

/** Every setting except the layout, which has its own reset. */
export const PREFERENCE_KEYS = ["theme", "fontSize", "tabSize", "wordWrap", "minimap", "recordHistory", "autoImport", "autoClose", "suggestions", "bracketColors"] as const;

function persist(s: Settings) {
  const saved = Object.fromEntries([...PREFERENCE_KEYS, "layout" as const].map((k) => [k, s[k]]));
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
}

export function resolveTheme(pref: ThemePreference): "dark" | "light" {
  if (pref !== "system") return pref;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: () => set({ ...load(), hydrated: true }),
  update: (patch) => {
    set(patch);
    persist(get());
  },
  updateLayout: (patch) => {
    set({ layout: { ...get().layout, ...patch } });
    persist(get());
  },
  resetLayout: () => {
    set({ layout: DEFAULT_SETTINGS.layout });
    persist(get());
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("react-resizable-panels:")) localStorage.removeItem(k);
    } catch {}
  },
}));
