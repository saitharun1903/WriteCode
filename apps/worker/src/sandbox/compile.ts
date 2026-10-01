import { compilePlans, type ExecutionLimits, type ExecutionRequest, type LanguageDefinition } from "@cw/shared";
import { classifyCompile } from "./classify.js";
import type { Sandbox, StepResult } from "./sandbox.js";

export interface CompileResult {
  /** The step that decided the result: the build that worked, or the last one tried. */
  step: StepResult;
  /** What the compiler printed: for the build that worked, or for the first one when none did. */
  output: string;
  /** Time spent compiling, every attempt included. */
  durationMs: number;
}

/**
 * Builds the program that starts in the request's entry file. The builds of
 * `compilePlans` are tried in order within one compile time limit, so another
 * program in the project that does not compile does not stop this one. The
 * output is returned whole (not streamed): only the build that counts is shown.
 */
export async function compileProgram(
  sandbox: Sandbox,
  lang: LanguageDefinition,
  request: Pick<ExecutionRequest, "entry" | "files">,
  template: readonly string[],
  limits: ExecutionLimits,
  isCancelled: () => Promise<boolean>,
): Promise<CompileResult> {
  let first: string | undefined;
  let durationMs = 0;
  let step: StepResult | undefined;
  for (const plan of compilePlans(lang, request, template)) {
    const left = limits.compileTimeoutMs - durationMs;
    if (step && left < 1000) break;
    let output = "";
    step = await sandbox.runStep({
      argv: plan.argv,
      timeoutMs: Math.max(left, 1000),
      maxOutputBytes: limits.maxOutputBytes,
      onStdout: (c) => void (output += c),
      onStderr: (c) => void (output += c),
      isCancelled,
    });
    durationMs += step.durationMs;
    if (!classifyCompile(step)) return { step, output, durationMs };
    // Only a build the compiler itself refused is worth trying another way; a stop (time, memory, cancel) ends the sandbox.
    if (step.cancelled || step.timedOut || step.outputLimited || step.oomKilled || step.exitCode === null || sandbox.isKilled) return { step, output, durationMs };
    first ??= output;
  }
  return { step: step!, output: first ?? "", durationMs };
}
