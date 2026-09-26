import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { DEFAULT_LIMITS, type ExecutionLimits } from "@cw/shared";

// One .env at the repository root serves every service; it is optional.
for (const path of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(path)) process.loadEnvFile(path);
}

const production = process.env.NODE_ENV === "production";

/** A setting with a local-development default; required in production. */
function setting(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (production) throw new Error(`${name} must be set in production`);
  return devDefault;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

export const config = {
  workerId: `${hostname()}-${process.pid}`,
  redisUrl: setting("REDIS_URL", "redis://localhost:6379"),
  concurrency: int("WORKER_CONCURRENCY", 2, 1, 32),
  /** Concurrent debug sessions per worker. Sessions are long-lived, so they have their own pool. */
  debugConcurrency: int("DEBUG_CONCURRENCY", 2, 0, 16),
  /** Optional OCI runtime such as gVisor's `runsc` for stronger isolation. */
  runtime: process.env.SANDBOX_RUNTIME || undefined,
  dockerHost: process.env.DOCKER_HOST || undefined,
  limits: {
    ...DEFAULT_LIMITS,
    timeoutMs: int("SANDBOX_TIMEOUT_MS", DEFAULT_LIMITS.timeoutMs, 1000, 60_000),
    memoryMb: int("SANDBOX_MEMORY_MB", DEFAULT_LIMITS.memoryMb, 64, 4096),
  } satisfies ExecutionLimits,
  /** Workspace tmpfs size. Counts against the memory limit. */
  workspaceMb: 64,
  /** Largest single file a program may write (RLIMIT_FSIZE). */
  maxFileSizeBytes: 16 * 1024 * 1024,
  /** Touched on every successful heartbeat; the container health check reads its age. */
  healthFile: process.env.WORKER_HEALTH_FILE || "",
  /** Characters of each stream kept in Postgres; the live stream carries everything. */
  storedOutputChars: 64 * 1024,
};

export type WorkerConfig = typeof config;

// DATABASE_URL is read by @cw/db; check it here so a missing value fails at startup.
if (production) setting("DATABASE_URL", "");
