import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { redisKeys, type RunnerHeartbeat } from "@cw/shared";
import { REDIS } from "../infra/infra.module.js";

export interface RunnerStatus {
  available: boolean;
  readyLanguages: string[];
  reason?: string;
  workers: number;
}

/** Aggregates worker heartbeats into a single view of sandbox availability. */
@Injectable()
export class RunnerStatusService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async get(): Promise<RunnerStatus> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", redisKeys.runnerHeartbeatPattern, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    const beats = (keys.length ? await this.redis.mget(keys) : [])
      .filter((v): v is string => !!v)
      .map((v) => JSON.parse(v) as RunnerHeartbeat);

    if (beats.length === 0) {
      return { available: false, readyLanguages: [], workers: 0, reason: "No execution worker is running. Start it with `pnpm dev`." };
    }
    const ready = [...new Set(beats.filter((b) => b.dockerAvailable).flatMap((b) => b.readyLanguages))];
    return {
      available: ready.length > 0,
      readyLanguages: ready,
      workers: beats.length,
      reason: ready.length > 0 ? beats.find((b) => b.reason)?.reason : (beats.find((b) => b.reason)?.reason ?? "The sandbox is not ready."),
    };
  }
}
