import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res, ServiceUnavailableException } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Redis } from "ioredis";
import { ASSISTANT_LIMITS, getLanguage, redisKeys, validateAssistantRequest, type AssistantEvent, type ComplexityEstimate, type GeneratedProblem, type ProblemDifficulty } from "@cw/shared";
import { clientHash } from "../common/request-context.js";
import { config } from "../config.js";
import { REDIS } from "../infra/infra.module.js";
import { AssistantError } from "./gemini.js";
import { parseProblem, problemPrompt } from "./problem.js";
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
        effort: parsed.value.effort,
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

  /**
   * Estimates the time and space complexity of a program, for an interviewer.
   * Always an estimate: no tool can determine it exactly for every program.
   */
  @Post("assistant/complexity")
  @HttpCode(200)
  async complexity(@Body() body: unknown, @Req() req: Request): Promise<ComplexityEstimate> {
    if (!config.assistant.apiKey || config.assistant.models.length === 0) throw new ServiceUnavailableException("The assistant isn't available on this server.");
    const b = (body && typeof body === "object" ? body : {}) as { language?: unknown; files?: unknown };
    const language = typeof b.language === "string" ? getLanguage(b.language) : undefined;
    const files = Array.isArray(b.files)
      ? b.files.filter((f): f is { path: string; content: string } => !!f && typeof f.path === "string" && typeof f.content === "string").slice(0, 20)
      : [];
    const size = files.reduce((n, f) => n + f.content.length + f.path.length, 0);
    if (!language || !files.length || size > 200_000) throw new BadRequestException("Send the language and the program's files (up to 200 KB).");
    await this.checkLimits(clientHash(req.ip));

    const code = files.map((f) => `--- ${f.path.slice(0, 200)}\n${f.content}`).join("\n\n");
    const systemInstruction = {
      parts: [
        {
          text: [
            "You analyse the algorithmic complexity of programs for a technical interviewer.",
            'Reply with ONLY one JSON object and nothing else: {"time": "O(...)", "space": "O(...)", "explanation": "..."}.',
            "Use n for the size of the input (name other variables, e.g. m, when there are several).",
            "Give the worst case. Space means extra memory beyond the input.",
            "The explanation is 2 to 4 plain sentences naming the loops, calls or data structures that decide it, with line numbers when clear. No LaTeX, no markdown.",
          ].join(" "),
        },
      ],
    };
    const contents = [{ role: "user" as const, parts: [{ text: `Language: ${language.name}\n\n${code}` }] }];
    let text = "";
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    try {
      await this.router.answer({ question: "review the complexity", effort: "medium", systemInstruction, contents, signal: abort.signal, onChunk: (c) => c.kind === "text" && (text += c.text) });
    } catch (e) {
      const err = e instanceof AssistantError ? e : new AssistantError("The assistant is temporarily unavailable. Please try again.", String(e));
      throw new HttpException(err.userMessage, 502);
    }
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    try {
      const r = JSON.parse(json) as Partial<ComplexityEstimate>;
      if (typeof r.time !== "string" || typeof r.space !== "string") throw new Error("shape");
      return { time: r.time.slice(0, 60), space: r.space.slice(0, 60), explanation: String(r.explanation ?? "").slice(0, 1200) };
    } catch {
      throw new HttpException("The assistant's answer could not be read. Try again.", 502);
    }
  }

  /**
   * Writes an interview problem from a short topic: statement, sample and
   * edge-case inputs, a reference solution, a brute-force check and an input
   * generator. The browser computes the expected outputs by running them.
   */
  @Post("assistant/interview-problem")
  @HttpCode(200)
  async interviewProblem(@Body() body: unknown, @Req() req: Request): Promise<GeneratedProblem> {
    if (!config.assistant.apiKey || config.assistant.models.length === 0) throw new ServiceUnavailableException("Problem writing isn't available on this server.");
    const b = (body && typeof body === "object" ? body : {}) as { topic?: unknown; difficulty?: unknown };
    const topic = typeof b.topic === "string" ? b.topic.trim().slice(0, 2000) : "";
    const difficulty: ProblemDifficulty = b.difficulty === "easy" || b.difficulty === "hard" ? b.difficulty : "medium";
    if (topic.length < 2) throw new BadRequestException("Type what the problem is about, e.g. prime numbers.");
    await this.checkLimits(clientHash(req.ip));

    const { systemInstruction, contents } = problemPrompt(topic, difficulty);
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    // Two attempts: an unreadable reply is usually fine the second time.
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = "";
      try {
        await this.router.answer({ question: "write a problem with edge cases", effort: "medium", systemInstruction, contents, signal: abort.signal, onChunk: (c) => c.kind === "text" && (text += c.text) });
      } catch (e) {
        const err = e instanceof AssistantError ? e : new AssistantError("Problem writing is temporarily unavailable. Please try again.", String(e));
        throw new HttpException(err.userMessage.replace(/^The assistant/, "Problem writing"), err.status === 429 ? 429 : 502);
      }
      const problem = parseProblem(text);
      if (problem) return problem;
    }
    throw new HttpException("The problem could not be written. Try again, or describe it in a few more words.", 502);
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
