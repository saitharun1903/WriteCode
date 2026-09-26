import { Logger } from "@nestjs/common";
import { Redis, type RedisOptions } from "ioredis";
import { config } from "../config.js";

/**
 * Creates a Redis connection that logs outages once (not per retry) and
 * never surfaces unhandled `error` events.
 */
export function createRedis(name: string, options: RedisOptions = {}): Redis {
  const logger = new Logger(`Redis:${name}`);
  const redis = new Redis(config.redisUrl, options);
  let down = false;
  redis.on("error", (e: Error & { code?: string }) => {
    if (!down) logger.error(`unavailable (${e.code ?? (e.message || "connection error")}); retrying in the background`);
    down = true;
  });
  redis.on("ready", () => {
    if (down) logger.log("reconnected");
    down = false;
  });
  return redis;
}
