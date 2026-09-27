import { BadRequestException, Body, Controller, Get, HttpException, Inject, Post, Req, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Redis } from "ioredis";
import { ASSISTANT_LIMITS, redisKeys, validateAssistantRequest, type AssistantEvent } from "@cw/shared";
import { clientHash } from "../common/request-context.js";
import { config } from "../config.js";
import { REDIS } from "../infra/infra.module.js";
import { AssistantError } from "./gemini.js";
import { buildPrompt } from "./prompt.js";
import { AnswerRouter } from "./router.js";

const BUSY = "The assistant is getting a lot of requests right now. Please try again in a minute.";

@Controller()
export class AssistantController {
  private readonly router: AnswerRouter;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.router = new AnswerRouter(redis);
  }

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
      const question = parsed.value.messages[parsed.value.messages.length - 1]!.text;
      model = await this.router.answer({
        question,
        systemInstruction,
        contents,
        signal: abort.signal,
        onChunk: (chunk) => {
          if (chunk.kind === "text") chars += chunk.text.length;
          send({ type: chunk.kind, text: chunk.text });
        },
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
