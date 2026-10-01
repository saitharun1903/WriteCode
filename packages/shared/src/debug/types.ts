/**
 * Debugger protocol shared by the browser, API and worker. The worker relays
 * these to a language-specific adapter running inside the sandbox.
 */

export type DebugCommand =
  | { cmd: "continue" }
  | { cmd: "pause" }
  | { cmd: "stepOver" }
  | { cmd: "stepIn" }
  | { cmd: "stepOut" }
  | { cmd: "setBreakpoints"; file: string; lines: number[] }
  | { cmd: "variables"; ref: number }
  | { cmd: "evaluate"; expression: string; frame: number }
  | { cmd: "terminate" };

export interface DebugFrame {
  id: number;
  /** Qualified method name, e.g. `Main.square`. */
  name: string;
  /** Project file, or null for frames outside the project (JDK code). */
  file: string | null;
  line: number;
  /** Variables reference for this frame's locals; 0 when unavailable. */
  localsRef: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
  /** Non-zero when the value has children that can be expanded. */
  ref: number;
  length?: number;
}

export type StopReason = "breakpoint" | "step" | "pause" | "exception" | "entry";

export type DebugEvent =
  | { kind: "stopped"; reason: StopReason; thread: string; frames: DebugFrame[]; description?: string }
  | { kind: "continued" }
  /** `actual`: the line the breakpoint really stops on, when the line it was set on has no code. */
  | { kind: "breakpoints"; file: string; breakpoints: { line: number; verified: boolean; actual?: number }[] }
  | {
      kind: "response";
      requestId: string;
      command: DebugCommand["cmd"];
      success: boolean;
      message?: string;
      /** `variables` responses. */
      ref?: number;
      variables?: DebugVariable[];
      /** `evaluate` responses. */
      expression?: string;
      result?: Omit<DebugVariable, "name">;
      error?: string;
    };

export const DEBUG_LIMITS = {
  maxBreakpoints: 500,
  maxLine: 100_000,
  maxExpressionLength: 500,
  maxRequestIdLength: 64,
} as const;

/** Normalizes breakpoint lines: integers within range, deduplicated and sorted. Null when invalid. */
export function validLines(input: unknown[]): number[] | null {
  if (input.length > DEBUG_LIMITS.maxBreakpoints) return null;
  const lines = new Set<number>();
  for (const l of input) {
    if (!Number.isInteger(l) || (l as number) < 1 || (l as number) > DEBUG_LIMITS.maxLine) return null;
    lines.add(l as number);
  }
  return [...lines].sort((a, b) => a - b);
}

/** Validates an untrusted debug command from a client. Returns null when invalid. */
export function parseDebugCommand(input: unknown): DebugCommand | null {
  if (typeof input !== "object" || input === null) return null;
  const c = input as Record<string, unknown>;
  switch (c.cmd) {
    case "continue":
    case "pause":
    case "stepOver":
    case "stepIn":
    case "stepOut":
    case "terminate":
      return { cmd: c.cmd };
    case "setBreakpoints": {
      if (typeof c.file !== "string" || c.file.length > 200 || !Array.isArray(c.lines)) return null;
      const lines = validLines(c.lines);
      return lines ? { cmd: "setBreakpoints", file: c.file, lines } : null;
    }
    case "variables": {
      const ref = c.ref;
      return typeof ref === "number" && Number.isInteger(ref) && ref > 0 && ref < 1e9 ? { cmd: "variables", ref } : null;
    }
    case "evaluate": {
      const { expression, frame } = c;
      if (typeof expression !== "string" || !expression.trim() || expression.length > DEBUG_LIMITS.maxExpressionLength) return null;
      if (typeof frame !== "number" || !Number.isInteger(frame) || frame < 0 || frame > 10_000) return null;
      return { cmd: "evaluate", expression, frame };
    }
    default:
      return null;
  }
}
