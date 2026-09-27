import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantError, streamAnswer } from "./gemini.js";

const sse = (...events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");

function mockFetch(status: number, body: string) {
  const fn = vi.fn(async () => new Response(body, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const thinking: string[] = [];
const run = async () => {
  thinking.length = 0;
  let text = "";
  for await (const c of streamAnswer({ apiKey: "test-key", model: "m", thinking: "low", systemInstruction: { parts: [] }, contents: [], signal: new AbortController().signal })) {
    if (c.kind === "text") text += c.text;
    else thinking.push(c.text);
  }
  return text;
};

afterEach(() => vi.unstubAllGlobals());

describe("streamAnswer", () => {
  it("streams answer text and reasoning summaries separately, and sends the key only as a header", async () => {
    const fetchFn = mockFetch(
      200,
      sse(
        { candidates: [{ content: { parts: [{ text: "thinking…", thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: "Change `<=` " }] } }] },
        { candidates: [{ content: { parts: [{ text: "to `<`." }] }, finishReason: "STOP" }] },
      ),
    );
    expect(await run()).toBe("Change `<=` to `<`.");
    expect(thinking).toEqual(["thinking…"]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("maps quota errors to a friendly, non-technical message", async () => {
    mockFetch(429, JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }));
    await expect(run()).rejects.toMatchObject({ status: 429, retryable: false, userMessage: expect.stringContaining("try again in a minute") });
  });

  it("marks an overloaded model as retryable", async () => {
    mockFetch(503, JSON.stringify({ error: { status: "UNAVAILABLE", message: "high demand" } }));
    await expect(run()).rejects.toMatchObject({ retryable: true });
  });

  it("does not reveal key problems to users", async () => {
    mockFetch(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "API key not valid" } }));
    const err = (await run().catch((e: unknown) => e)) as AssistantError;
    expect(err.userMessage).toBe("The assistant isn't available right now.");
    expect(err.detail).toContain("API key not valid");
  });

  it("reports blocked answers and empty answers", async () => {
    mockFetch(200, sse({ candidates: [{ finishReason: "SAFETY" }] }));
    await expect(run()).rejects.toBeInstanceOf(AssistantError);
    mockFetch(200, sse({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    await expect(run()).rejects.toMatchObject({ detail: "empty answer (STOP)", retryable: true });
  });

  it("says so when an answer is cut off by the length limit", async () => {
    mockFetch(200, sse({ candidates: [{ content: { parts: [{ text: "Part one" }] }, finishReason: "MAX_TOKENS" }] }));
    expect(await run()).toContain("cut off");
  });
});
