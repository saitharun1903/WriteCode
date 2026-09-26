import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createPrismaClient, type PrismaClient } from "@cw/db";
import { DEBUG_QUEUE, EXECUTION_QUEUE, type ExecutionJob } from "@cw/shared";
import { createRedis } from "./redis.js";

export const REDIS = Symbol("REDIS");
export const PRISMA = Symbol("PRISMA");
export const EXECUTION_QUEUE_TOKEN = Symbol("EXECUTION_QUEUE");
export const DEBUG_QUEUE_TOKEN = Symbol("DEBUG_QUEUE");

export type ExecutionQueue = Queue<ExecutionJob>;

function createQueue(name: string): ExecutionQueue {
  const queue = new Queue<ExecutionJob>(name, { connection: createRedis(name, { maxRetriesPerRequest: null }) });
  // Connection errors are already reported once by the Redis connection.
  queue.on("error", () => {});
  return queue;
}

@Injectable()
class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(EXECUTION_QUEUE_TOKEN) private readonly queue: ExecutionQueue,
    @Inject(DEBUG_QUEUE_TOKEN) private readonly debugQueue: ExecutionQueue,
  ) {}

  async onApplicationShutdown() {
    await Promise.all([this.queue.close(), this.debugQueue.close()]);
    await this.prisma.$disconnect();
    this.redis.disconnect();
  }
}

/** Shared infrastructure clients: Redis, Postgres (Prisma) and the execution queue. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      // Fail fast while Redis is down instead of queueing commands indefinitely.
      useFactory: () => createRedis("main", { maxRetriesPerRequest: 2, enableOfflineQueue: false }),
    },
    { provide: PRISMA, useFactory: () => createPrismaClient() },
    { provide: EXECUTION_QUEUE_TOKEN, useFactory: () => createQueue(EXECUTION_QUEUE) },
    { provide: DEBUG_QUEUE_TOKEN, useFactory: () => createQueue(DEBUG_QUEUE) },
    InfraLifecycle,
  ],
  exports: [REDIS, PRISMA, EXECUTION_QUEUE_TOKEN, DEBUG_QUEUE_TOKEN],
})
export class InfraModule {}
