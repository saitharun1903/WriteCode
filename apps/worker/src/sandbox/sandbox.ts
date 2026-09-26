import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type Docker from "dockerode";
import type { Container } from "dockerode";
import { SANDBOX_WORKDIR, type ExecutionLimits, type SourceFile } from "@cw/shared";
import type { StepOutcome } from "./classify.js";
import { buildWriteBatches } from "./files.js";

export const SANDBOX_LABEL = "cw.sandbox";
const NOBODY = "65534:65534";
const STDIN_PATH = "/tmp/cw-stdin";

export interface SandboxOptions {
  image: string;
  executionId: string;
  limits: ExecutionLimits;
  runtime?: string;
  workspaceMb: number;
  maxFileSizeBytes: number;
}

export interface StepOptions {
  argv: string[];
  timeoutMs: number;
  /** Byte budget for this step's combined stdout + stderr. */
  maxOutputBytes: number;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** Polled while the step runs; returning true kills the sandbox. */
  isCancelled: () => Promise<boolean>;
  /** Redirect the program's stdin from the file written by `writeStdin`. */
  withStdin?: boolean;
}

export interface StepResult extends StepOutcome {
  durationMs: number;
}

/**
 * One disposable container per execution. It idles on `sleep` while the
 * worker runs each step (write files, compile, run) with `docker exec`.
 * Everything the program can touch is in-memory and destroyed with it.
 */
export class Sandbox {
  private container: Container | null = null;
  private killed = false;

  constructor(
    private readonly docker: Docker,
    private readonly opts: SandboxOptions,
  ) {}

  async start(): Promise<void> {
    const { limits, image, executionId, runtime, workspaceMb, maxFileSizeBytes } = this.opts;
    const lifetimeSeconds = Math.ceil((limits.compileTimeoutMs + limits.timeoutMs) / 1000) + 30;
    this.container = await this.docker.createContainer({
      Image: image,
      Cmd: ["sleep", String(lifetimeSeconds)],
      User: NOBODY,
      WorkingDir: SANDBOX_WORKDIR,
      Env: ["HOME=/tmp", "LANG=C.UTF-8", "PYTHONDONTWRITEBYTECODE=1", "PYTHONUNBUFFERED=1", "NODE_OPTIONS=--max-old-space-size=192"],
      Labels: { [SANDBOX_LABEL]: "1", "cw.execution": executionId },
      NetworkDisabled: true,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      HostConfig: {
        NetworkMode: "none",
        Memory: limits.memoryMb * 1024 * 1024,
        MemorySwap: limits.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(limits.cpus * 1e9),
        PidsLimit: limits.pids,
        ReadonlyRootfs: true,
        Tmpfs: {
          [SANDBOX_WORKDIR]: `rw,exec,nosuid,nodev,size=${workspaceMb}m,uid=65534,gid=65534,mode=0755`,
          "/tmp": `rw,exec,nosuid,nodev,size=${workspaceMb}m,mode=1777`,
        },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Ulimits: [
          { Name: "nofile", Soft: 256, Hard: 256 },
          { Name: "fsize", Soft: maxFileSizeBytes, Hard: maxFileSizeBytes },
          { Name: "core", Soft: 0, Hard: 0 },
        ],
        Init: true,
        IpcMode: "private",
        LogConfig: { Type: "none", Config: {} },
        ...(runtime ? { Runtime: runtime } : {}),
      },
    });
    await this.container.start();
  }

  /** Writes project files into the workspace. Throws on failure (a system error, not a user error). */
  async writeFiles(files: readonly SourceFile[]): Promise<void> {
    await this.execSimple(["mkdir", "-p", "out"]);
    for (const batch of buildWriteBatches(files)) await this.execSimple(batch.argv);
  }

  async writeStdin(stdin: string): Promise<void> {
    const b64 = Buffer.from(stdin, "utf8").toString("base64");
    await this.execSimple(["sh", "-c", 'printf %s "$1" | base64 -d > "$2"', "sh", b64, STDIN_PATH]);
  }

  /** Runs a step, streaming decoded output, and enforces time, output and cancellation limits. */
  async runStep(step: StepOptions): Promise<StepResult> {
    const container = this.requireContainer();
    const argv = step.withStdin ? ["sh", "-c", `exec "$@" < ${STDIN_PATH}`, "sh", ...step.argv] : step.argv;
    const exec = await container.exec({
      Cmd: argv,
      User: NOBODY,
      WorkingDir: SANDBOX_WORKDIR,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const outcome: StepOutcome = { exitCode: null, timedOut: false, outputLimited: false, cancelled: false, oomKilled: false };
    const started = performance.now();
    const stream = await exec.start({ hijack: false, stdin: false });

    let bytes = 0;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

    const account = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes <= step.maxOutputBytes) return true;
      if (!outcome.outputLimited) {
        outcome.outputLimited = true;
        void this.kill();
      }
      return false;
    };
    stdout.on("data", (c: Buffer) => account(c) && step.onStdout(outDecoder.write(c)));
    stderr.on("data", (c: Buffer) => account(c) && step.onStderr(errDecoder.write(c)));
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const timer = setTimeout(() => {
      outcome.timedOut = true;
      void this.kill();
    }, step.timeoutMs);
    const cancelPoll = setInterval(() => {
      void step.isCancelled().then((c) => {
        if (c && !outcome.cancelled) {
          outcome.cancelled = true;
          void this.kill();
        }
      });
    }, 250);

    try {
      await new Promise<void>((resolve) => {
        stream.on("end", resolve);
        stream.on("close", resolve);
        stream.on("error", resolve);
      });
    } finally {
      clearTimeout(timer);
      clearInterval(cancelPoll);
    }

    const tailOut = outDecoder.end();
    const tailErr = errDecoder.end();
    if (tailOut) step.onStdout(tailOut);
    if (tailErr) step.onStderr(tailErr);

    const durationMs = Math.round(performance.now() - started);
    if (!this.killed) {
      const info = await exec.inspect();
      outcome.exitCode = info.ExitCode ?? null;
    } else {
      outcome.exitCode = 137;
    }
    outcome.oomKilled = await this.wasOomKilled();
    return { ...outcome, durationMs };
  }

  /** Peak memory of the container's cgroup when Docker reports it (cgroup v1 only). */
  async peakMemoryBytes(): Promise<number | undefined> {
    if (!this.container || this.killed) return undefined;
    try {
      const stats = (await this.container.stats({ stream: false })) as { memory_stats?: { max_usage?: number } };
      return stats.memory_stats?.max_usage || undefined;
    } catch {
      return undefined;
    }
  }

  async kill(): Promise<void> {
    if (!this.container || this.killed) return;
    this.killed = true;
    try {
      await this.container.kill({ signal: "SIGKILL" });
    } catch {
      // Already stopped.
    }
  }

  async dispose(): Promise<void> {
    if (!this.container) return;
    try {
      await this.container.remove({ force: true, v: true });
    } catch {
      // Removal is retried by the startup sweeper if it fails here.
    }
    this.container = null;
  }

  get isKilled(): boolean {
    return this.killed;
  }

  private async wasOomKilled(): Promise<boolean> {
    try {
      const info = await this.requireContainer().inspect();
      return !!info.State?.OOMKilled;
    } catch {
      return false;
    }
  }

  /** Runs a worker-controlled command to completion; non-zero exit is a system error. */
  private async execSimple(argv: string[]): Promise<void> {
    const container = this.requireContainer();
    const exec = await container.exec({ Cmd: argv, User: NOBODY, WorkingDir: SANDBOX_WORKDIR, AttachStdout: true, AttachStderr: true, Tty: false });
    const stream = await exec.start({ hijack: false, stdin: false });
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (c: Buffer) => chunks.push(c));
    this.docker.modem.demuxStream(stream, sink, sink);
    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("close", resolve);
      stream.on("error", reject);
    });
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0) {
      throw new Error(`sandbox setup step failed (exit ${ExitCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 500)}`);
    }
  }

  private requireContainer(): Container {
    if (!this.container) throw new Error("sandbox not started");
    return this.container;
  }
}
