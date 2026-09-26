import type { Redis } from "ioredis";
import {
  EXECUTION_TTL_SECONDS,
  STREAM_FIELD,
  redisKeys,
  type DebugEvent,
  type ExecutionResult,
  type ExecutionStatus,
  type ExecutionStreamEvent,
} from "@cw/shared";

type ChunkType = "stdout" | "stderr" | "compile" | "stdin";

/** Cap on stream entries per execution; chunks are coalesced so this is rarely reached. */
const MAX_STREAM_ENTRIES = 5000;
const FLUSH_INTERVAL_MS = 30;
const FLUSH_BYTES = 16 * 1024;

/**
 * Publishes execution events to a Redis Stream. Output chunks are coalesced
 * (every 30 ms or 16 KB) so a chatty program cannot flood Redis or the socket.
 */
export class EventEmitter {
  private pending: { type: ChunkType; text: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly redis: Redis,
    private readonly executionId: string,
  ) {}

  status(status: ExecutionStatus) {
    this.flushChunks();
    this.push({ type: "status", executionId: this.executionId, status });
  }

  debug(event: DebugEvent) {
    // Flush pending output first so the client sees output before the pause that follows it.
    this.flushChunks();
    this.push({ type: "debug", executionId: this.executionId, event });
  }

  chunk(type: ChunkType, text: string) {
    if (!text) return;
    if (this.pending && this.pending.type !== type) this.flushChunks();
    this.pending = this.pending ? { type, text: this.pending.text + text } : { type, text };
    if (this.pending.text.length >= FLUSH_BYTES) this.flushChunks();
    else this.timer ??= setTimeout(() => this.flushChunks(), FLUSH_INTERVAL_MS);
  }

  /**
   * Stores the final result and emits it. SET NX makes the first writer win,
   * so a result the API already recorded (e.g. cancelled while queued) is kept.
   */
  async result(result: ExecutionResult): Promise<void> {
    this.flushChunks();
    const id = this.executionId;
    this.chain = this.chain.then(async () => {
      const stored = await this.redis.set(redisKeys.result(id), JSON.stringify(result), "EX", EXECUTION_TTL_SECONDS, "NX");
      if (stored !== "OK") return;
      const event: ExecutionStreamEvent = { type: "result", executionId: id, result };
      await this.redis
        .multi()
        .xadd(redisKeys.events(id), "*", STREAM_FIELD, JSON.stringify(event))
        .expire(redisKeys.events(id), EXECUTION_TTL_SECONDS)
        .exec();
    });
    await this.chain;
  }

  private flushChunks() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const { type, text } = this.pending;
    this.pending = null;
    this.push({ type, executionId: this.executionId, chunk: text } as ExecutionStreamEvent);
  }

  private push(event: ExecutionStreamEvent) {
    const key = redisKeys.events(this.executionId);
    // Serialize writes so events keep their order.
    this.chain = this.chain.then(() =>
      this.redis.xadd(key, "MAXLEN", "~", String(MAX_STREAM_ENTRIES), "*", STREAM_FIELD, JSON.stringify(event)),
    );
    this.chain.catch(() => {});
  }
}
