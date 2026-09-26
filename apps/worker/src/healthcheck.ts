/**
 * Container health check for the worker: healthy while the heartbeat file is
 * fresh, i.e. the worker recently reached both Redis and Docker.
 * Usage: node dist/healthcheck.js (reads WORKER_HEALTH_FILE).
 */
import { statSync } from "node:fs";

const file = process.env.WORKER_HEALTH_FILE;
const MAX_AGE_MS = 30_000;

try {
  if (!file) throw new Error("WORKER_HEALTH_FILE is not set");
  const age = Date.now() - statSync(file).mtimeMs;
  if (age > MAX_AGE_MS) throw new Error(`last heartbeat ${Math.round(age / 1000)}s ago`);
  process.exit(0);
} catch (e) {
  console.error(`unhealthy: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
