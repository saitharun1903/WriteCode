import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { config } from "../config.js";
import { explainHttp, secondsUntilPacificMidnight } from "./gemini.js";
import { AnswerRouter, routeFor } from "./router.js";

/** Just enough of ioredis for the router. */
function fakeRedis(latency: Record<string, string> = {}) {
  const store = new Map<string, { value: string; ttl: number }>();
  const hash = { ...latency };
  const redis = {
    get: async (k: string) => store.get(k)?.value ?? null,
    mget: async (...keys: string[]) => keys.map((k) => store.get(k)?.value ?? null),
    set: async (k: string, value: string, _ex: string, ttl: number) => void store.set(k, { value, ttl }),
    hgetall: async () => ({ ...hash }),
    hget: async (_k: string, f: string) => hash[f] ?? null,
    hset: async (_k: string, f: string, v: string) => void (hash[f] = v),
  } as unknown as Redis;
  return { redis, store, hash };
}

const sse = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] })}\n\n`;
const thought = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text, thought: true }] } }] })}\n\n`;

type Reply = { status?: number; body?: string; delayMs?: number; json?: object };

/** Fake Gemini: per model, an optional delay before the stream, honouring aborts. */
function mockModels(replies: Record<string, Reply>) {
  const calls: { model: string; thinking: string }[] = [];
  const aborted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const model = /models\/([^:]+):/.exec(url)![1]!;
      calls.push({ model, thinking: JSON.parse(init.body as string).generationConfig.thinkingConfig.thinkingLevel });
      const r = replies[model]!;
      if (r.status && r.status !== 200) return new Response(JSON.stringify(r.json ?? { error: { status: "X" } }), { status: r.status });
      const signal = init.signal!;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(r.body!));
            controller.close();
          }, r.delayMs ?? 0);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted.push(model);
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(stream, { status: 200 });
    }),
  );
  return { calls, aborted };
}

const quota = (quotaId: string, retryDelay = "6s") => ({ status: 429, json: { error: { details: [{ violations: [{ quotaId }] }, { retryDelay }] } } });

async function ask(router: AnswerRouter, question = "fix it") {
  let text = "";
  const thinking: string[] = [];
  const model = await router.answer({
    question,
    systemInstruction: { parts: [] },
    contents: [],
    signal: new AbortController().signal,
    onChunk: (c) => (c.kind === "text" ? (text += c.text) : thinking.push(c.text)),
  });
  return { model, text, thinking };
}

const saved = { models: [...config.assistant.models], fast: [...config.assistant.fastModels], hedge: config.assistant.hedgeMs };
beforeEach(() => {
  config.assistant.models.splice(0, Infinity, "big", "mid");
  config.assistant.fastModels.splice(0, Infinity, "lite", "lite2");
  config.assistant.hedgeMs = 60;
});
afterEach(() => {
  config.assistant.models.splice(0, Infinity, ...saved.models);
  config.assistant.fastModels.splice(0, Infinity, ...saved.fast);
  config.assistant.hedgeMs = saved.hedge;
  vi.unstubAllGlobals();
});

describe("routing", () => {
  it("sends everyday questions to the fast models and deep reviews to the strong ones", () => {
    expect(routeFor("My last run didn't work. What went wrong? Fix it.")).toBe("fast");
    expect(routeFor("Explain what Candies.java does")).toBe("fast");
    expect(routeFor("Check Main.java for bugs or edge cases")).toBe("deep");
    expect(routeFor("How can I improve this code?")).toBe("deep");
  });

  it("uses light reasoning on the fast route and more on the deep route", async () => {
    const { redis } = fakeRedis();
    const { calls } = mockModels({ lite: { body: sse("ok") }, big: { body: sse("ok") } });
    expect((await ask(new AnswerRouter(redis), "fix it")).model).toBe("lite");
    expect((await ask(new AnswerRouter(redis), "find bugs")).model).toBe("big");
    expect(calls).toEqual([
      { model: "lite", thinking: "low" },
      { model: "big", thinking: "medium" },
    ]);
  });
});

describe("effort", () => {
  it("low: fast models with the least reasoning, even for reviews", async () => {
    const { candidates } = await new AnswerRouter(fakeRedis().redis).plan("deep", "low");
    expect(candidates).toEqual([
      { model: "lite", thinking: "low" },
      { model: "lite2", thinking: "low" },
      { model: "big", thinking: "low" },
      { model: "mid", thinking: "low" },
    ]);
  });

  it("high: strong models reasoning longest, even for simple questions", async () => {
    const { candidates } = await new AnswerRouter(fakeRedis().redis).plan("fast", "high");
    expect(candidates).toEqual([
      { model: "big", thinking: "high" },
      { model: "mid", thinking: "high" },
      { model: "lite", thinking: "medium" },
      { model: "lite2", thinking: "medium" },
    ]);
  });

  it("sends the chosen reasoning level to Gemini", async () => {
    const { redis } = fakeRedis();
    const { calls } = mockModels({ big: { body: sse("careful answer") } });
    const router = new AnswerRouter(redis);
    await router.answer({ question: "fix it", effort: "high", systemInstruction: { parts: [] }, contents: [], signal: new AbortController().signal, onChunk: () => {} });
    expect(calls).toEqual([{ model: "big", thinking: "high" }]);
  });
});

describe("hedging", () => {
  it("starts a second model when the first is slow, keeps the faster answer and cancels the other", async () => {
    const { redis, hash } = fakeRedis();
    const { calls, aborted } = mockModels({ lite: { body: thought("**Reading**") + sse("slow answer"), delayMs: 400 }, lite2: { body: sse("fast answer"), delayMs: 10 } });
    const result = await ask(new AnswerRouter(redis));
    expect(result).toMatchObject({ model: "lite2", text: "fast answer" });
    expect(calls.map((c) => c.model)).toEqual(["lite", "lite2"]);
    expect(aborted).toContain("lite");
    expect(Number(hash.lite2)).toBeGreaterThan(0);
  });

  it("does not start a second model when the first answers in time", async () => {
    const { redis } = fakeRedis();
    const { calls } = mockModels({ lite: { body: sse("quick"), delayMs: 5 }, lite2: { body: sse("never") } });
    expect((await ask(new AnswerRouter(redis))).text).toBe("quick");
    expect(calls).toHaveLength(1);
  });
});

describe("resting models", () => {
  it("rests a model out of daily quota until the reset, and an overloaded one for two minutes", async () => {
    const { redis, store } = fakeRedis();
    mockModels({ lite: quota("GenerateRequestsPerDayPerProjectPerModel-FreeTier"), lite2: { status: 503 }, big: { body: sse("answer") } });
    expect(await ask(new AnswerRouter(redis))).toMatchObject({ model: "big", text: "answer" });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get("ai:exhausted:lite")?.value).toBe("day");
    expect(store.get("ai:exhausted:lite2")).toEqual({ value: "busy", ttl: 120 });
  });

  it("skips resting models without asking them, and tries recently slow ones last", async () => {
    const { redis, store } = fakeRedis({ lite: "25000" });
    store.set("ai:exhausted:big", { value: "day", ttl: 100 });
    const router = new AnswerRouter(redis);
    const { candidates } = await router.plan("fast");
    expect(candidates.map((c) => c.model)).toEqual(["lite2", "mid", "lite"]);
  });

  it("says the free answers are used up for today only when every model is out", async () => {
    const { redis, store } = fakeRedis();
    for (const m of ["big", "mid", "lite", "lite2"]) store.set(`ai:exhausted:${m}`, { value: "day", ttl: 100 });
    await expect(ask(new AnswerRouter(redis))).rejects.toMatchObject({ userMessage: expect.stringContaining("back tomorrow") });
  });

  it("never switches models once answer text was sent", async () => {
    const { redis } = fakeRedis();
    const broken = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Half" }] } }] })}\n\ndata: {not json\n\n`;
    const { calls } = mockModels({ lite: { body: broken }, lite2: { body: sse("again") } });
    await expect(ask(new AnswerRouter(redis))).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe("quota helpers", () => {
  it("reads daily and per-minute quota errors", () => {
    expect(explainHttp(429, JSON.stringify({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } })).quota).toEqual({
      daily: true,
      retryAfterSeconds: 60,
    });
    expect(explainHttp(429, JSON.stringify({ error: { details: [{ violations: [{ quotaId: "PerMinute" }] }, { retryDelay: "12.5s" }] } })).quota).toEqual({
      daily: false,
      retryAfterSeconds: 13,
    });
  });

  it("counts down to midnight in California", () => {
    // 23:00 PDT on 2026-09-27 is 06:00 UTC on the 28th: one hour to go, plus the minute of margin.
    expect(secondsUntilPacificMidnight(new Date("2026-09-28T06:00:00Z"))).toBe(3600 + 60);
  });
});
