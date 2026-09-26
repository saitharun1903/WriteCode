import { Controller, Get, Inject } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@cw/db";
import { LANGUAGES } from "@cw/shared";
import { PRISMA, REDIS } from "../infra/infra.module.js";
import { RunnerStatusService } from "./runner-status.service.js";

async function probe(fn: () => Promise<unknown>): Promise<"up" | "down"> {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500))]);
    return "up";
  } catch {
    return "down";
  }
}

@Controller()
export class HealthController {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly runners: RunnerStatusService,
  ) {}

  @Get("health")
  async health() {
    const [redis, database] = await Promise.all([probe(() => this.redis.ping()), probe(() => this.prisma.$queryRaw`SELECT 1`)]);
    const runner =
      redis === "up"
        ? await this.runners.get()
        : { available: false, readyLanguages: [] as string[], workers: 0, reason: "Redis is not reachable from the API." };
    const available = runner.available && database === "up";
    return {
      status: available ? "ok" : "degraded",
      services: { redis, database },
      runner: {
        available,
        workers: runner.workers,
        reason: database === "down" ? "The database is not reachable from the API." : runner.reason,
      },
      languages: LANGUAGES.map((l) => ({
        id: l.id,
        name: l.name,
        version: l.version,
        supportLevel: l.supportLevel,
        ready: runner.readyLanguages.includes(l.id),
      })),
    };
  }
}
