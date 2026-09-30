/**
 * Language definitions are the single source of truth for everything the
 * frontend, API and execution worker need to know about a language.
 * Nothing outside this module should switch on a language id.
 */

/** How reliably a language is supported. Only `stable` is advertised as fully supported. */
export type SupportLevel = "stable" | "beta" | "planned";

export interface CompilerConfig {
  /** Command run inside the sandbox working directory. `{sources}` expands to all source files. */
  command: string[];
  /** File extensions passed to the compiler when `{sources}` is used. */
  sourceExtensions: string[];
}

export interface RuntimeConfig {
  /** Pinned container image used by the sandbox. The version below must match it. */
  image: string;
  /** Command that runs the program. `{entry}` expands to the entry file, `{entryClass}` to the entry path without extension with `/` replaced by `.` (a JVM class name). */
  command: string[];
}

export interface DebuggerConfig {
  protocol: "jdwp" | "dap" | "settrace" | "inspector";
  supportLevel: SupportLevel;
}

export interface VisualizerConfig {
  supportLevel: SupportLevel;
}

export interface TemplateFile {
  path: string;
  content: string;
}

export interface LanguageDefinition {
  id: string;
  name: string;
  /** Human-readable toolchain version, derived from the pinned image. */
  version: string;
  extensions: string[];
  /** Monaco language id used for highlighting. */
  monacoLanguage: string;
  supportLevel: SupportLevel;
  /** Default entry point for new projects. */
  entryFile: string;
  template: TemplateFile[];
  runtime: RuntimeConfig;
  compiler?: CompilerConfig;
  debugger?: DebuggerConfig;
  visualizer?: VisualizerConfig;
}
