import { AlertTriangle, Ban, CheckCircle2, Clock, Cpu, HardDrive, Keyboard, Loader2, OctagonX, XCircle } from "lucide-react";
import type { ExecutionStatus } from "@cw/shared";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "running" | "input" | "success" | "danger" | "warning";

export const STATUS_META: Record<ExecutionStatus | "SUBMITTING", { label: string; tone: Tone; hint?: string }> = {
  SUBMITTING: { label: "Starting", tone: "running" },
  QUEUED: { label: "Queued", tone: "running", hint: "Waiting for a free sandbox." },
  STARTING: { label: "Starting", tone: "running", hint: "Creating the sandbox." },
  COMPILING: { label: "Compiling", tone: "running" },
  RUNNING: { label: "Running", tone: "running" },
  WAITING_FOR_INPUT: { label: "Waiting for input", tone: "input", hint: "The program is waiting for you to type input." },
  SUCCESS: { label: "Success", tone: "success" },
  COMPILATION_ERROR: { label: "Compilation error", tone: "danger", hint: "The compiler rejected the program. See Problems for locations." },
  RUNTIME_ERROR: { label: "Runtime error", tone: "danger", hint: "The program exited with a non-zero status or crashed." },
  TIME_LIMIT: { label: "Time limit exceeded", tone: "warning", hint: "The program ran longer than the allowed wall-clock time and was stopped." },
  MEMORY_LIMIT: { label: "Memory limit exceeded", tone: "warning", hint: "The program exceeded the sandbox memory limit and was killed." },
  OUTPUT_LIMIT: { label: "Output limit exceeded", tone: "warning", hint: "The program produced more output than allowed and was stopped." },
  CANCELLED: { label: "Stopped", tone: "neutral", hint: "Execution was stopped before it finished." },
  SYSTEM_ERROR: { label: "System error", tone: "danger", hint: "The execution service failed. This is not a problem with your code." },
};

const toneClass: Record<Tone, string> = {
  neutral: "bg-hover text-fg-muted",
  running: "bg-info-soft text-info",
  input: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
};

function StatusIcon({ status }: { status: ExecutionStatus | "SUBMITTING" }) {
  const cls = "size-3";
  switch (STATUS_META[status].tone) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin")} />;
    case "input":
      return <Keyboard className={cls} />;
    case "success":
      return <CheckCircle2 className={cls} />;
    case "warning":
      return status === "TIME_LIMIT" ? <Clock className={cls} /> : status === "MEMORY_LIMIT" ? <HardDrive className={cls} /> : <AlertTriangle className={cls} />;
    case "danger":
      return status === "SYSTEM_ERROR" ? <OctagonX className={cls} /> : <XCircle className={cls} />;
    default:
      return <Ban className={cls} />;
  }
}

export function StatusPill({ status, className }: { status: ExecutionStatus | "SUBMITTING"; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-xs font-medium",
        toneClass[meta.tone],
        className,
      )}
    >
      <StatusIcon status={status} />
      {meta.label}
    </span>
  );
}

export function formatDuration(ms?: number): string | null {
  if (ms === undefined) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatBytes(bytes?: number): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export { Cpu };
