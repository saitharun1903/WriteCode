"use client";

import { create } from "zustand";

export type ThemePreference = "dark" | "light" | "system";
/** Bottom tool windows. */
export type BottomTab = "run" | "debug" | "problems" | "input";
const BOTTOM_TABS: readonly BottomTab[] = ["run", "debug", "problems", "input"];
export type SideView = "explorer" | "search" | "history";

export interface Settings {
  theme: ThemePreference;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  /** Save an execution history entry for every run. */
  recordHistory: boolean;
  layout: {
    sidebarOpen: boolean;
    bottomOpen: boolean;
    sideView: SideView;
    bottomTab: BottomTab;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  fontSize: 14,
  tabSize: 4,
  wordWrap: false,
  minimap: false,
  recordHistory: true,
  layout: {
    sidebarOpen: true,
    bottomOpen: true,
    sideView: "explorer",
    bottomTab: "run",
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

function persist(s: Settings) {
  const { theme, fontSize, tabSize, wordWrap, minimap, recordHistory, layout } = s;
  try {
    localStorage.setItem(KEY, JSON.stringify({ theme, fontSize, tabSize, wordWrap, minimap, recordHistory, layout }));
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
