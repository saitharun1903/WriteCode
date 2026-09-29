import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { isTerminalStatus, redisKeys, type ExecutionStatus } from "@cw/shared";
import { config } from "../config.js";
import { REDIS } from "../infra/infra.module.js";

export type RateDecision = { ok: true } | { ok: false; reason: "rate" | "concurrency"; retryAfterSeconds: number };

/**
 * Entries older than this are treated as finished even if no completion was observed.
 * Longer than the longest session (debug and interactive runs last up to 15 minutes),
 * so long sessions keep counting against the client's cap.
 */
const ACTIVE_STALE_MS = 16 * 60 * 1000;

/**
 * Per-client limits backed by Redis so they hold across API instances:
 * a fixed one-minute window on submissions and a cap on in-flight runs.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async check(client: string, now = Date.now()): Promise<RateDecision> {
    const window = Math.floor(now / 60_000);
    const rateKey = redisKeys.rateWindow(client, window);
    const activeKey = redisKeys.activeByClient(client);

    const res = await this.redis
      .multi()
      .incr(rateKey)
      .expire(rateKey, 61)
      .zremrangebyscore(activeKey, 0, now - ACTIVE_STALE_MS)
      .zcard(activeKey)
      .exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const active = Number(res?.[3]?.[1] ?? 0);

    if (count > config.rateLimit.perMinute) {
      return { ok: false, reason: "rate", retryAfterSeconds: 60 - Math.floor((now % 60_000) / 1000) };
    }
    if (active >= config.rateLimit.concurrent && (await this.stillActive(activeKey)) >= config.rateLimit.concurrent) {
      return { ok: false, reason: "concurrency", retryAfterSeconds: 2 };
    }
    return { ok: true };
  }

  async markActive(client: string, executionId: string, now = Date.now()): Promise<void> {
    const key = redisKeys.activeByClient(client);
    await this.redis.multi().zadd(key, now, executionId).expire(key, ACTIVE_STALE_MS / 1000).exec();
  }

  /** Drops runs that have a final result but whose completion was missed (an API restart), and counts the rest. */
  private async stillActive(activeKey: string): Promise<number> {
    const ids = await this.redis.zrange(activeKey, "0", "-1");
    if (!ids.length) return 0;
    const results = await this.redis.mget(ids.map((id) => redisKeys.result(id)));
    const finished = ids.filter((_, i) => {
      const raw = results[i];
      if (!raw) return false;
      try {
        return isTerminalStatus((JSON.parse(raw) as { status: ExecutionStatus }).status);
      } catch {
        return false;
      }
    });
    if (finished.length) await this.redis.zrem(activeKey, ...finished);
    return ids.length - finished.length;
  }

  async markDone(client: string, executionId: string): Promise<void> {
    await this.redis.zrem(redisKeys.activeByClient(client), executionId);
  }
}
