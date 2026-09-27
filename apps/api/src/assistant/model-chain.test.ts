import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { config } from "../config.js";
import { AssistantController } from "./assistant.controller.js";
import { explainHttp, secondsUntilPacificMidnight } from "./gemini.js";

/** Just enough of ioredis for the model chain: get/set with expiry. */
function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    redis: {
      get: async (k: string) => store.get(k)?.value ?? null,
      set: async (k: string, value: string, _ex: string, ttl: number) => void store.set(k, { value, ttl }),
    } as unknown as Redis,
  };
}

const quota429 = (quotaId: string, retryDelay = "6s") =>
  new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId }] }, { retryDelay }] } }), { status: 429 });
const overloaded = () => new Response(JSON.stringify({ error: { code: 503, status: "UNAVAILABLE" } }), { status: 503 });
const answer = (text: string) => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] })}\n\n`, { status: 200 });

/** Routes fetch by model name in the URL. */
function mockModels(responses: Record<string, () => Response>) {
  const fn = vi.fn(async (url: string) => {
    const model = /models\/([^:]+):/.exec(url)![1]!;
    return responses[model]!();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const run = (ctrl: AssistantController) => {
  let text = "";
  const answered = (ctrl as unknown as { answer: (...a: unknown[]) => Promise<string> }).answer({ parts: [] }, [], new AbortController().signal, (t: string) => (text += t));
  return answered.then((model) => ({ model, text }));
};

const saved = [...config.assistant.models];
beforeEach(() => config.assistant.models.splice(0, config.assistant.models.length, "big", "mid", "lite"));
afterEach(() => {
  config.assistant.models.splice(0, config.assistant.models.length, ...saved);
  vi.unstubAllGlobals();
});

describe("assistant model chain", () => {
  it("answers from the next model when one is out of daily quota or overloaded, and rests the exhausted one", async () => {
    const { redis, store } = fakeRedis();
    const fetchFn = mockModels({ big: () => quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier"), mid: overloaded, lite: () => answer("Use `<`.") });
    const ctrl = new AssistantController(redis);
    expect(await run(ctrl)).toEqual({ model: "lite", text: "Use `<`." });
    expect(store.get("ai:exhausted:big")?.value).toBe("day");
    expect(store.get("ai:exhausted:big")!.ttl).toBeGreaterThan(60);
    // Overload is not remembered: the next question tries it again.
    expect(store.has("ai:exhausted:mid")).toBe(false);

    fetchFn.mockClear();
    await run(ctrl);
    const tried = fetchFn.mock.calls.map(([url]) => /models\/([^:]+):/.exec(url as string)![1]);
    expect(tried).toEqual(["mid", "lite"]);
  });

  it("rests a model for the per-minute delay Google gives", async () => {
    const { redis, store } = fakeRedis();
    mockModels({ big: () => quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "38s"), mid: () => answer("ok"), lite: () => answer("x") });
    expect((await run(new AssistantController(redis))).model).toBe("mid");
    expect(store.get("ai:exhausted:big")).toEqual({ value: "minute", ttl: 38 });
  });

  it("says the free answers are used up for today only when every model is out", async () => {
    const { redis } = fakeRedis();
    mockModels({ big: () => quota429("PerDay-a"), mid: () => quota429("PerDay-b"), lite: () => quota429("PerDay-c") });
    await expect(run(new AssistantController(redis))).rejects.toMatchObject({ userMessage: expect.stringContaining("back tomorrow") });
  });

  it("never switches models after text was sent", async () => {
    const { redis } = fakeRedis();
    const broken = () =>
      new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Half" }] } }] })}\n\ndata: {not json\n\n`, { status: 200 });
    const fetchFn = mockModels({ big: broken, mid: () => answer("again"), lite: () => answer("again") });
    await expect(run(new AssistantController(redis))).rejects.toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("quota helpers", () => {
  it("reads daily and per-minute quota errors", () => {
    expect(explainHttp(429, JSON.stringify({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } })).quota).toEqual({ daily: true, retryAfterSeconds: 60 });
    expect(explainHttp(429, JSON.stringify({ error: { details: [{ violations: [{ quotaId: "PerMinute" }] }, { retryDelay: "12.5s" }] } })).quota).toEqual({ daily: false, retryAfterSeconds: 13 });
  });

  it("counts down to midnight in California", () => {
    // 23:00 PDT on 2026-09-27 is 06:00 UTC on the 28th: one hour to go, plus the minute of margin.
    expect(secondsUntilPacificMidnight(new Date("2026-09-28T06:00:00Z"))).toBe(3600 + 60);
  });
});
