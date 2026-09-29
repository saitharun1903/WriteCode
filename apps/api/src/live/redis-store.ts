import type { Redis } from "ioredis";
import { LIVE_LIMITS } from "@cw/shared";
import type { LiveStore, RoomMeta } from "./rooms.js";

const TTL = LIVE_LIMITS.idleTtlSeconds;
const metaKey = (id: string) => `live:${id}:meta`;
const docKey = (id: string) => `live:${id}:doc`;
const clientKey = (client: string) => `live:client:${client}`;

/** Sessions in Redis. Every save renews the expiry, so a session lives until a day after its last use. */
export class RedisLiveStore implements LiveStore {
  constructor(private readonly redis: Redis) {}

  async getMeta(id: string): Promise<RoomMeta | null> {
    const raw = await this.redis.get(metaKey(id));
    return raw ? (JSON.parse(raw) as RoomMeta) : null;
  }

  async putMeta(meta: RoomMeta): Promise<void> {
    // An ended session is remembered briefly so its link says "ended" rather than "not found".
    await this.redis.set(metaKey(meta.id), JSON.stringify(meta), "EX", meta.ended ? 3600 : TTL);
  }

  async getDoc(id: string): Promise<Uint8Array | null> {
    const buf = await this.redis.getBuffer(docKey(id));
    return buf ? new Uint8Array(buf) : null;
  }

  async putDoc(id: string, state: Uint8Array): Promise<void> {
    await this.redis.set(docKey(id), Buffer.from(state), "EX", TTL);
  }

  async deleteDoc(id: string): Promise<void> {
    await this.redis.del(docKey(id));
  }

  async openRooms(client: string): Promise<number> {
    const key = clientKey(client);
    await this.redis.zremrangebyscore(key, 0, Date.now() - TTL * 1000);
    return this.redis.zcard(key);
  }

  async addRoom(client: string, id: string): Promise<void> {
    await this.redis.multi().zadd(clientKey(client), Date.now(), id).expire(clientKey(client), TTL).exec();
  }

  async removeRoom(client: string, id: string): Promise<void> {
    await this.redis.zrem(clientKey(client), id);
  }
}
