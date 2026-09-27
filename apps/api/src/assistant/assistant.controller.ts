import { BadRequestException, Body, Controller, Get, HttpException, Inject, Post, Req, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Redis } from "ioredis";
import { ASSISTANT_LIMITS, redisKeys, validateAssistantRequest, type AssistantEvent } from "@cw/shared";
import { clientHash } from "../common/request-context.js";
import { config } from "../config.js";
import { REDIS } from "../infra/infra.module.js";
import { AssistantError, secondsUntilPacificMidnight, streamAnswer, type Chunk } from "./gemini.js";
import { buildPrompt, type GeminiContent } from "./prompt.js";

const BUSY = "The assistant is getting a lot of requests right now. Please try again in a minute.";

@Controller()
export class AssistantController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Whether the assistant is configured on this server. Never reveals the key or model account. */
  @Get("assistant/status")
  status() {
    return { available: config.assistant.apiKey.length > 0 };
  }

  /**
   * Answers a question about the user's project as server-sent events:
   * `{type:"text"}` chunks, then `{type:"done"}` or `{type:"error"}`.
   */
  @Post("assistant/chat")
  async chat(@Body() body: unknown, @Req() req: Request, @Res() res: Response) {
    if (!config.assistant.apiKey || config.assistant.models.length === 0) throw new ServiceUnavailableException("The assistant isn't available on this server.");
    const parsed = validateAssistantRequest(body);
    if (!parsed.ok) throw new BadRequestException(parsed.error);
    await this.checkLimits(clientHash(req.ip));

    const { systemInstruction, contents } = buildPrompt(parsed.value);
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    // no-transform keeps the reverse proxy from compressing (and so buffering) the stream.
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (event: AssistantEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    const started = Date.now();
    let chars = 0;
    let outcome = "done";
    let model = "";
    try {
      model = await this.answer(systemInstruction, contents, abort.signal, (chunk) => {
        if (chunk.kind === "text") chars += chunk.text.length;
        send({ type: chunk.kind, text: chunk.text });
      });
      send({ type: "done" });
    } catch (e) {
      if (abort.signal.aborted) {
        outcome = "client closed";
      } else {
        const err = e instanceof AssistantError ? e : new AssistantError("The assistant is temporarily unavailable. Please try again.", String(e));
        outcome = `error: ${err.detail}`;
        send({ type: "error", message: err.userMessage });
      }
    } finally {
      // Logged without the question, code or answer.
      process.stdout.write(
        JSON.stringify({
          time: new Date().toISOString(),
          level: outcome.startsWith("error") ? "warn" : "info",
          msg: "assistant answer",
          service: "api",
          requestId: res.locals.requestId,
          model,
          outcome,
          ms: Date.now() - started,
          answerChars: chars,
        }) + "\n",
      );
      res.end();
    }
  }

  /**
   * Streams the answer from the first model in the chain that still has quota.
   * Nothing is retried once text has been sent, so answers never repeat.
   * Returns the model that answered.
   */
  private async answer(
    systemInstruction: { parts: { text: string }[] },
    contents: GeminiContent[],
    signal: AbortSignal,
    onChunk: (chunk: Chunk) => void,
  ): Promise<string> {
    let sent = false;
    let last: AssistantError | null = null;
    let dailyOut = 0;
    for (const model of config.assistant.models) {
      const resting = await this.redis.get(`ai:exhausted:${model}`);
      if (resting) {
        if (resting === "day") dailyOut++;
        continue;
      }
      try {
        for await (const chunk of streamAnswer({ apiKey: config.assistant.apiKey, model, systemInstruction, contents, signal })) {
          // Reasoning summaries may come from a model that then fails; answer text never repeats.
          if (chunk.kind === "text") sent = true;
          onChunk(chunk);
        }
        return model;
      } catch (e) {
        if (!(e instanceof AssistantError) || sent || signal.aborted) throw e;
        if (e.quota) {
          // Skip this model until its quota resets: Google's daily quotas reset at midnight Pacific time.
          const ttl = e.quota.daily ? secondsUntilPacificMidnight() : Math.max(20, e.quota.retryAfterSeconds);
          await this.redis.set(`ai:exhausted:${model}`, e.quota.daily ? "day" : "minute", "EX", ttl);
          if (e.quota.daily) dailyOut++;
        } else if (!e.retryable) {
          throw e;
        }
        last = e;
      }
    }
    if (dailyOut === config.assistant.models.length) {
      throw new AssistantError("The assistant has used up today's free answers. It will be back tomorrow.", "all models out of daily quota", 429);
    }
    throw last ?? new AssistantError(BUSY, "all models resting", 429);
  }

  /** Per-client minute and day windows, plus a global per-minute cap that protects the key's quota. */
  private async checkLimits(client: string) {
    const now = Date.now();
    const minute = Math.floor(now / 60_000);
    const day = Math.floor(now / 86_400_000);
    const m = redisKeys.assistantMinute(client, minute);
    const d = redisKeys.assistantDay(client, day);
    const g = `ai:global:m:${minute}`;
    const res = await this.redis.multi().incr(m).expire(m, 61).incr(d).expire(d, 86_401).incr(g).expire(g, 61).exec();
    const [perMinute, perDay, global] = [Number(res?.[0]?.[1] ?? 0), Number(res?.[2]?.[1] ?? 0), Number(res?.[4]?.[1] ?? 0)];
    if (perDay > ASSISTANT_LIMITS.perDay) throw new HttpException("You've reached today's limit for the assistant. It resets tomorrow.", 429);
    if (perMinute > ASSISTANT_LIMITS.perMinute) throw new HttpException("You're asking faster than the assistant can keep up. Please wait a minute.", 429);
    if (global > config.assistant.globalPerMinute) throw new HttpException(BUSY, 429);
  }
}
