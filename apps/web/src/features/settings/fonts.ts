/**
 * The fonts code can be shown in: the editor, the console and every other
 * place code appears. The files are loaded in app/fonts.ts, one CSS variable
 * `--font-code-<id>` each; "system" uses the fonts the device already has.
 */
export interface CodeFont {
  id: string;
  label: string;
  /** Where people know it from. */
  note: string;
}

export const CODE_FONTS: readonly CodeFont[] = [
  { id: "jetbrains", label: "JetBrains Mono", note: "IntelliJ IDEA" },
  { id: "cascadia", label: "Cascadia Code", note: "Windows Terminal" },
  { id: "fira", label: "Fira Code", note: "Popular with VS Code" },
  { id: "system", label: "Consolas / Menlo", note: "VS Code default, already on your device" },
  { id: "source", label: "Source Code Pro", note: "Adobe" },
  { id: "plex", label: "IBM Plex Mono", note: "IBM" },
  { id: "roboto", label: "Roboto Mono", note: "Android Studio" },
  { id: "geist", label: "Geist Mono", note: "Vercel" },
  { id: "ubuntu", label: "Ubuntu Mono", note: "Ubuntu terminal" },
  { id: "inconsolata", label: "Inconsolata", note: "Narrow and compact" },
  { id: "victor", label: "Victor Mono", note: "Slim, with tall letters" },
  { id: "redhat", label: "Red Hat Mono", note: "Red Hat" },
  { id: "space", label: "Space Mono", note: "Wide and geometric" },
];

export const DEFAULT_CODE_FONT = "jetbrains";

export const isCodeFont = (id: unknown): id is string => typeof id === "string" && CODE_FONTS.some((f) => f.id === id);

/** The CSS value that names a font's family. */
export const codeFontVar = (id: string) => `var(--font-code-${isCodeFont(id) ? id : DEFAULT_CODE_FONT})`;

/** Makes `id` the font of all code on the page. */
export function applyCodeFont(id: string) {
  document.documentElement.style.setProperty("--font-code", codeFontVar(id));
}

/**
 * The family names the browser knows the font by (the editor measures letters
 * itself and needs the real names, not a CSS variable).
 */
export function codeFontFamily(id: string): string {
  const name = `--font-code-${isCodeFont(id) ? id : DEFAULT_CODE_FONT}`;
  const family = typeof document === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `${family ? `${family}, ` : ""}Consolas, "Courier New", monospace`;
}
