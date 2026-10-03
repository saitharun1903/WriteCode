import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LIVE_LIMITS } from "@cw/shared";

// One .env at the repository root serves every service; it is optional.
for (const path of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
  if (existsSync(path)) process.loadEnvFile(path);
}

const production = process.env.NODE_ENV === "production";

/** Best first. Verified to give correct answers with the assistant's prompt. */
const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview";
/** Fast models for everyday questions: about 1.5-2.5 s to the first word in measurements. */
const DEFAULT_FAST_MODELS = "gemini-3.5-flash-lite,gemini-3.1-flash-lite";

const list = (value: string | undefined, fallback: string) => [...new Set((value || fallback).split(",").map((m) => m.trim()).filter(Boolean))];

/**
 * A setting with a local-development default. In production the variable must
 * be set, so a missing value fails at startup instead of quietly pointing at
 * localhost or using a development secret.
 */
function setting(name: string, devDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (production) throw new Error(`${name} must be set in production`);
  return devDefault;
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
  redisUrl: setting("REDIS_URL", "redis://localhost:6379"),
  webOrigins: setting("WEB_ORIGIN", "http://localhost:3000").split(",").map((s) => s.trim()),
  clientHashSalt: setting("CLIENT_HASH_SALT", "local-dev-salt"),
  trustProxy: process.env.TRUST_PROXY === "1",
  rateLimit: {
    /** Executions per client per minute. */
    perMinute: int("RATE_LIMIT_PER_MINUTE", 30),
    /** Executions a client (a browser) may have queued or running at once. */
    concurrent: int("RATE_LIMIT_CONCURRENT", 3),
    /**
     * The same for a whole network address. Many browsers can share one (a classroom, an office),
     * so it is wider; it still bounds one address that invents browser ids.
     */
    ipPerMinute: int("RATE_LIMIT_IP_PER_MINUTE", 300),
    ipConcurrent: int("RATE_LIMIT_IP_CONCURRENT", 24),
    /** Global queue depth after which new executions are refused. */
    maxQueueDepth: int("MAX_QUEUE_DEPTH", 200),
  },
  /**
   * TURN relay for interview cameras (coturn with a shared secret, see deploy/). Optional:
   * without it, cameras connect directly, which some office and college networks block.
   * The secret never leaves the server; browsers get credentials that expire.
   */
  turn: {
    secret: process.env.TURN_SECRET ?? "",
    urls: (process.env.TURN_URLS ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
  },
  /** Live sessions one client may have going at once (development machines run many test sessions). */
  liveMaxRoomsPerClient: int("LIVE_MAX_ROOMS_PER_CLIENT", production ? LIVE_LIMITS.maxRoomsPerClient : 100),
  /**
   * Email (Resend) for invitations. Optional: without a key, invitations open
   * the user's own email app instead. The key never leaves the server.
   */
  email: {
    apiKey: process.env.RESEND_API_KEY?.trim() ?? "",
    /** Must be an address on a domain verified in Resend. */
    from: process.env.EMAIL_FROM?.trim() || "WriteCode <invites@writecode.in>",
  },
  /** WebSocket subscriptions allowed per connection. */
  maxSubscriptionsPerSocket: 8,
  /**
   * AI assistant (Google Gemini). Optional: without a key the assistant reports
   * itself unavailable and everything else works. The key stays on the server.
   */
  assistant: {
    apiKey: process.env.GEMINI_API_KEY?.trim() ?? "",
    /**
     * Models tried in order. Each has its own quota (on the free tier about 20
     * requests a day each for the larger ones), so when one is used up or
     * overloaded the next answers. GEMINI_MODEL, if set, goes first.
     */
    models: list([process.env.GEMINI_MODEL, process.env.GEMINI_MODELS || DEFAULT_MODELS].filter(Boolean).join(","), DEFAULT_MODELS),
    /** Fast models: answer everyday questions first (see assistant/router.ts). */
    fastModels: list(process.env.GEMINI_FAST_MODELS, DEFAULT_FAST_MODELS),
    /** Milliseconds without answer text before a second model is started in parallel. */
    hedgeMs: int("ASSISTANT_HEDGE_MS", 1800),
    /** Requests to the model per minute across all users, to stay inside the key's quota. */
    globalPerMinute: int("ASSISTANT_GLOBAL_PER_MINUTE", 10),
  },
};

if (production) {
  // DATABASE_URL is read by @cw/db; check it here so a missing value fails at startup.
  setting("DATABASE_URL", "");
  if (config.clientHashSalt === "local-dev-salt" || config.clientHashSalt.length < 16) {
    throw new Error("CLIENT_HASH_SALT must be a random value of at least 16 characters in production");
  }
}
