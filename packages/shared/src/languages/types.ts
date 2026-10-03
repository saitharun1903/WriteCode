/**
 * Language definitions are the single source of truth for everything the
 * frontend, API and execution worker need to know about a language.
 * Nothing outside this module should switch on a language id.
 */

/** How reliably a language is supported. Only `stable` is advertised as fully supported. */
export type SupportLevel = "stable" | "beta" | "planned";

export interface CompilerConfig {
  /**
   * Command run inside the sandbox working directory. `{sources}` expands to
   * the source files of the build, `{sourceRoots}` to the folders the compiler
   * may look in for the other files a source file uses.
   */
  command: string[];
  /** File extensions passed to the compiler when `{sources}` is used. */
  sourceExtensions: string[];
  /**
   * What one build makes, which decides the files it is given.
   * `program`: every source is linked into one program, so a file with a main
   * function of its own is another program and is left out.
   * `classes`: each source compiles to classes of its own, so the build takes
   * the file being run and the files whose types it uses.
   */
  builds: "program" | "classes";
}

/** How a file says that a program starts in it. */
export type EntryPointStyle =
  /** A `main` method in a class; several files may each have one. */
  | "class-main"
  /** A `main` function at the top of a file. */
  | "function-main"
  /** A guard that runs only when the file is started directly; any file runs without one. */
  | "main-guard";

/** A format compilers and runtimes report errors in. */
export type DiagnosticFormat =
  | "gcc"
  | "javac"
  | "jvm-trace"
  | "python"
  | "node"
  /** Go: `./main.go:7:14: undefined: y`, and the frames of a panic. */
  | "go"
  /** rustc: `error[E0308]: mismatched types` then ` --> main.rs:1:26`, and `panicked at main.rs:1:46:`. */
  | "rustc"
  /** The C# compiler: `Program.cs(5,13): error CS1002: ; expected`. */
  | "csc"
  /** .NET stack traces: `at Program.Main() in /workspace/Program.cs:line 5`. */
  | "dotnet-trace"
  | "php"
  | "ruby"
  /** Bash: `main.sh: line 3: foo: command not found`. */
  | "bash"
  /** `main.sql:3: error: no such table: t`. */
  | "plain";

export interface RuntimeConfig {
  /** Pinned container image used by the sandbox. The version below must match it. */
  image: string;
  /** Command that runs the program. `{entry}` expands to the entry file, `{entryClass}` to the entry path without extension with `/` replaced by `.` (a JVM class name). */
  command: string[];
}

export interface DebuggerConfig {
  /** `tracepoint`: Ruby, debugged and traced in its own interpreter with TracePoint. `delve`: Go, with Delve. */
  protocol: "jdwp" | "dap" | "settrace" | "inspector" | "gdb" | "tracepoint" | "delve";
  supportLevel: SupportLevel;
  /** Image with the debugger's tools, when the runtime image lacks them. Used by the visualizer too. */
  image?: string;
  /** Compile command for debugging and visualizing (no optimisation, full debug info). */
  compiler?: string[];
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
  /** How a file of this language marks where a program starts; absent when there is no marker. */
  entryPoints?: EntryPointStyle;
  /**
   * `function-main` only: a regular expression (multi-line, on the code with its
   * comments and strings blanked) that matches the declaration of the main
   * function. Without it, a C `int main(` at the top level of the file.
   */
  entryPattern?: string;
  /** What its toolchain needs beyond the usual sandbox (the Kotlin compiler does not fit in the usual memory). */
  sandbox?: { memoryMb: number };
  /** `tables`: the program prints the results of queries as tables (see sql-runner.ts), which the console draws as tables. */
  output?: "tables";
  /**
   * The project has a database that its runs share (see sql-runner.ts): a run
   * is sent the database in this file and prints it back after its output.
   */
  database?: { file: string };
  /**
   * Set for a language that runs in the visitor's browser, not in a sandbox:
   * Run shows the page in a preview. Its `runtime` names no image or command.
   */
  preview?: "browser";
  /**
   * How a file loads another file of the project, for languages that run a
   * file directly: regular expressions (multi-line) whose first group is the
   * module named, or a comma-separated list of them. They tell a module of
   * the program apart from a program of its own.
   */
  imports?: string[];
  /** The formats its compiler and runtime report errors in. */
  diagnostics: DiagnosticFormat[];
  template: TemplateFile[];
  runtime: RuntimeConfig;
  compiler?: CompilerConfig;
  debugger?: DebuggerConfig;
  visualizer?: VisualizerConfig;
}
