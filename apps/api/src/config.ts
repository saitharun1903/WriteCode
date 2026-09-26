import { existsSync } from "node:fs";
import { resolve } from "node:path";

// One .env at the repository root serves every service; it is optional.
for (const path of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(path)) process.loadEnvFile(path);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export const config = {
  port: int("API_PORT", 4000),
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  webOrigins: (process.env.WEB_ORIGIN || "http://localhost:3000").split(",").map((s) => s.trim()),
  clientHashSalt: process.env.CLIENT_HASH_SALT || "local-dev-salt",
  trustProxy: process.env.TRUST_PROXY === "1",
  rateLimit: {
    /** Executions per client per minute. */
    perMinute: int("RATE_LIMIT_PER_MINUTE", 30),
    /** Executions a client may have queued or running at once. */
    concurrent: int("RATE_LIMIT_CONCURRENT", 3),
    /** Global queue depth after which new executions are refused. */
    maxQueueDepth: int("MAX_QUEUE_DEPTH", 200),
  },
  /** WebSocket subscriptions allowed per connection. */
  maxSubscriptionsPerSocket: 8,
};
