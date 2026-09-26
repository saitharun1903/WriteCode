import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { STREAM_FIELD, redisKeys, type ExecutionStreamEvent } from "@cw/shared";
import { REDIS } from "../infra/infra.module.js";
import { createRedis } from "../infra/redis.js";

export interface Subscriber {
  send: (event: ExecutionStreamEvent) => void;
}

interface Subscription {
  executionId: string;
  subscriber: Subscriber;
  /** Last stream entry delivered to this subscriber. */
  lastId: string;
}

/** Compares Redis stream ids ("<ms>-<seq>"). */
export function compareStreamIds(a: string, b: string): number {
  const [am = "0", as = "0"] = a.split("-");
  const [bm = "0", bs = "0"] = b.split("-");
  if (am !== bm) return am.length !== bm.length ? am.length - bm.length : am < bm ? -1 : 1;
  return Number(as) - Number(bs);
}

const BLOCK_MS = 5000;
const READ_COUNT = 256;

/**
 * Fans execution events out to WebSocket subscribers using a single blocking
 * XREAD loop over all active streams. Each subscriber starts from the first
 * entry, so late subscribers get a full replay and nothing is missed between
 * the HTTP submit and the socket subscribe.
 */
@Injectable()
export class StreamHub implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamHub.name);
  private readonly subs = new Set<Subscription>();
  private blocking!: Redis;
  private blockingClientId: number | null = null;
  private running = false;
  private wake: (() => void) | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onModuleInit() {
    this.blocking = createRedis("stream-reader", { maxRetriesPerRequest: null });
    this.blocking.on("ready", () => {
      void this.blocking.client("ID").then((id) => (this.blockingClientId = Number(id)));
    });
    this.running = true;
    void this.loop();
  }

  async onModuleDestroy() {
    this.running = false;
    this.wake?.();
    await this.interrupt();
    this.blocking.disconnect();
  }

  subscribe(executionId: string, subscriber: Subscriber): () => void {
    const sub: Subscription = { executionId, subscriber, lastId: "0-0" };
    this.subs.add(sub);
    this.wake?.();
    // Restart a blocked XREAD so the new stream is included immediately.
    void this.interrupt();
    return () => this.subs.delete(sub);
  }

  /** Number of clients currently following an execution. */
  subscribers(executionId: string): number {
    let n = 0;
    for (const s of this.subs) if (s.executionId === executionId) n++;
    return n;
  }

  get size(): number {
    return this.subs.size;
  }

  private async interrupt() {
    if (this.blockingClientId === null) return;
    try {
      await this.redis.client("UNBLOCK", this.blockingClientId);
    } catch {
      // Not blocked or Redis unavailable; the loop will pick up changes on its next pass.
    }
  }

  private async loop() {
    while (this.running) {
      if (this.subs.size === 0) {
        await new Promise<void>((resolve) => (this.wake = resolve));
        this.wake = null;
        continue;
      }
      // Read each stream from the oldest position any of its subscribers still needs.
      const from = new Map<string, string>();
      for (const s of this.subs) {
        const cur = from.get(s.executionId);
        if (!cur || compareStreamIds(s.lastId, cur) < 0) from.set(s.executionId, s.lastId);
      }
      const ids = [...from.keys()];
      try {
        const res = (await this.blocking.xread(
          "COUNT",
          READ_COUNT,
          "BLOCK",
          BLOCK_MS,
          "STREAMS",
          ...ids.map((id) => redisKeys.events(id)),
          ...ids.map((id) => from.get(id)!),
        )) as [string, [string, string[]][]][] | null;
        if (res) this.deliver(res);
      } catch (e) {
        if (!this.running) break;
        this.logger.debug(`stream read failed: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private deliver(res: [string, [string, string[]][]][]) {
    for (const [key, entries] of res) {
      const executionId = key.slice("exec:".length, key.length - ":events".length);
      const targets = [...this.subs].filter((s) => s.executionId === executionId);
      for (const [entryId, fields] of entries) {
        const idx = fields.indexOf(STREAM_FIELD);
        if (idx === -1) continue;
        let event: ExecutionStreamEvent;
        try {
          event = JSON.parse(fields[idx + 1]!) as ExecutionStreamEvent;
        } catch {
          continue;
        }
        for (const sub of targets) {
          if (compareStreamIds(entryId, sub.lastId) <= 0) continue;
          sub.lastId = entryId;
          try {
            sub.subscriber.send(event);
          } catch {
            this.subs.delete(sub);
          }
          if (event.type === "result") this.subs.delete(sub);
        }
      }
    }
  }
}
