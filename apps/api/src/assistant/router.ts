import type { Redis } from "ioredis";
import { config } from "../config.js";
import { AssistantError, secondsUntilPacificMidnight, streamAnswer, type Chunk } from "./gemini.js";
import type { GeminiContent } from "./prompt.js";

/**
 * Chooses which Gemini models answer a question and races them when one is slow.
 *
 * - Most questions (fix this error, explain this code, explain this step) go to
 *   the fast models with light reasoning: measured at 1.5-2.5 s to the first
 *   word, with correct fixes and traces on real programs.
 * - Deep work (find bugs, review, improve, optimise) goes to the larger models
 *   with more reasoning, with the fast models behind them.
 * - Hedging: if the model answering has not produced any answer text after
 *   `hedgeMs`, the next model starts in parallel; the first to answer wins and
 *   the other is cancelled. A model overloaded on Google's side therefore
 *   cannot keep the user waiting.
 * - Models that are overloaded, rate limited or out of daily quota are rested
 *   in Redis, and models that have recently been slow are tried last.
 */

const BUSY = "The assistant is getting a lot of requests right now. Please try again in a minute.";
const DEEP = /\b(bugs?|review|improve|improvements?|optimi[sz]e|refactor|edge cases?|complexity|efficien\w*|best practices?|clean ?up)\b/i;
/** Recently slower than this to the first word: try the model after the others. */
const SLOW_MS = 12_000;
/** Seconds an overloaded model is skipped before being tried again. */
const OVERLOAD_REST_S = 120;

export type Route = "fast" | "deep";

export function routeFor(question: string): Route {
  return DEEP.test(question) ? "deep" : "fast";
}

interface Candidate {
  model: string;
  thinking: "low" | "medium";
}

const restKey = (model: string) => `ai:exhausted:${model}`;
const LATENCY_KEY = "ai:latency";

export class AnswerRouter {
  constructor(private readonly redis: Redis) {}

  /** Models to try, in order, with their reasoning level; resting models are left out. */
  async plan(route: Route): Promise<{ candidates: Candidate[]; dailyOut: number; total: number }> {
    const fast = config.assistant.fastModels.map((model) => ({ model, thinking: "low" as const }));
    const strong = config.assistant.models.map((model) => ({ model, thinking: route === "deep" ? ("medium" as const) : ("low" as const) }));
    const ordered = (route === "deep" ? [...strong, ...fast] : [...fast, ...strong]).filter((c, i, all) => all.findIndex((x) => x.model === c.model) === i);
    const names = ordered.map((c) => c.model);
    const [rests, latencies] = await Promise.all([
      names.length ? this.redis.mget(...names.map(restKey)) : Promise.resolve([]),
      this.redis.hgetall(LATENCY_KEY).catch(() => ({}) as Record<string, string>),
    ]);
    const available = ordered.filter((_, i) => !rests[i]);
    const slow = (c: Candidate) => Number((latencies as Record<string, string>)[c.model] ?? 0) > SLOW_MS;
    return {
      // Stable: keeps the preferred order within the quick and the slow group.
      candidates: [...available.filter((c) => !slow(c)), ...available.filter(slow)],
      dailyOut: rests.filter((r) => r === "day").length,
      total: ordered.length,
    };
  }

  private async rest(model: string, e: AssistantError) {
    if (e.quota) {
      // Google's daily quotas reset at midnight Pacific time.
      const ttl = e.quota.daily ? secondsUntilPacificMidnight() : Math.max(20, e.quota.retryAfterSeconds);
      await this.redis.set(restKey(model), e.quota.daily ? "day" : "minute", "EX", ttl);
    } else if (e.retryable) {
      await this.redis.set(restKey(model), "busy", "EX", OVERLOAD_REST_S);
    }
  }

  private async recordLatency(model: string, ms: number) {
    const previous = Number(await this.redis.hget(LATENCY_KEY, model).catch(() => null));
    const next = previous > 0 ? Math.round(previous * 0.6 + ms * 0.4) : ms;
    await this.redis.hset(LATENCY_KEY, model, String(next)).catch(() => {});
  }

  /**
   * Streams one answer. Reasoning summaries come from the model leading the
   * race; answer text only ever comes from the winner, so it never repeats.
   * Resolves with the model that answered.
   */
  async answer(opts: {
    question: string;
    systemInstruction: { parts: { text: string }[] };
    contents: GeminiContent[];
    signal: AbortSignal;
    onChunk: (chunk: Chunk) => void;
  }): Promise<string> {
    const { candidates, dailyOut, total } = await this.plan(routeFor(opts.question));
    if (candidates.length === 0) {
      throw dailyOut === total
        ? new AssistantError("The assistant has used up today's free answers. It will be back tomorrow.", "all models out of daily quota", 429)
        : new AssistantError(BUSY, "all models resting", 429);
    }

    return new Promise<string>((resolve, reject) => {
      let next = 0;
      let running = 0;
      let winner: string | null = null;
      let lead: string | null = null;
      let settled = false;
      let lastError: AssistantError | null = null;
      const controllers = new Map<string, AbortController>();

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        for (const c of controllers.values()) c.abort();
        fn();
      };

      const launch = (): boolean => {
        if (settled || winner || next >= candidates.length) return false;
        const { model, thinking } = candidates[next++]!;
        const own = new AbortController();
        controllers.set(model, own);
        running++;
        lead ??= model;
        const started = Date.now();
        const hedge = setTimeout(() => launch(), config.assistant.hedgeMs);

        void (async () => {
          try {
            for await (const chunk of streamAnswer({
              apiKey: config.assistant.apiKey,
              model,
              thinking,
              systemInstruction: opts.systemInstruction,
              contents: opts.contents,
              signal: AbortSignal.any([opts.signal, own.signal]),
            })) {
              if (winner && winner !== model) return;
              if (chunk.kind === "text" && !winner) {
                winner = model;
                clearTimeout(hedge);
                void this.recordLatency(model, Date.now() - started);
                // The other racers lose: cancel them.
                for (const [m, c] of controllers) if (m !== model) c.abort();
              }
              if (winner === model || (!winner && lead === model)) opts.onChunk(chunk);
            }
            if (winner === model) settle(() => resolve(model));
            else if (!winner) throw new AssistantError("The assistant returned an empty answer. Please try again.", "empty answer", 502, true);
          } catch (e) {
            if (winner === model) return settle(() => reject(e));
            if (own.signal.aborted || opts.signal.aborted) {
              if (opts.signal.aborted) settle(() => reject(e));
              return;
            }
            const err = e instanceof AssistantError ? e : new AssistantError("The assistant is temporarily unavailable. Please try again.", String(e), 502, true);
            if (!err.quota && !err.retryable) return settle(() => reject(err));
            lastError = err;
            void this.rest(model, err);
          } finally {
            clearTimeout(hedge);
            running--;
            controllers.delete(model);
            if (!winner && !settled) {
              // Out of the race: another running model takes the lead (and its reasoning is shown),
              // or, if none is running, the next one starts now.
              if (lead === model) lead = [...controllers.keys()][0] ?? null;
              if (running === 0 && !launch()) settle(() => reject(lastError ?? new AssistantError(BUSY, "no model answered", 429)));
            }
          }
        })();
        return true;
      };

      launch();
    });
  }
}
