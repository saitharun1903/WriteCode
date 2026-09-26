import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@cw/db";
import { LANGUAGES } from "@cw/shared";
import { PRISMA, REDIS } from "../infra/infra.module.js";
import { RunnerStatusService } from "./runner-status.service.js";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

async function probe(fn: () => Promise<unknown>): Promise<"up" | "down"> {
  try {
    // Generous enough for a cold connection pool right after startup.
    await withTimeout(fn(), 3000);
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

  /** Liveness: the process is up and serving. Checks nothing else, so it never hangs. */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /**
   * Readiness: Redis, the database and at least one execution worker are
   * reachable. 503 otherwise, with the details. Every probe has a timeout.
   */
  @Get("health/ready")
  async ready() {
    const report = await this.health();
    if (report.status !== "ok") throw new HttpException(report, HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  /** Detailed status for the IDE's status bar (always 200). */
  @Get("health")
  async health() {
    const [redis, database] = await Promise.all([probe(() => this.redis.ping()), probe(() => this.prisma.$queryRaw`SELECT 1`)]);
    const unreachable = { available: false, readyLanguages: [] as string[], workers: 0, reason: "Redis is not reachable from the API." };
    const runner = redis === "up" ? await withTimeout(this.runners.get(), 3000).catch(() => unreachable) : unreachable;
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
