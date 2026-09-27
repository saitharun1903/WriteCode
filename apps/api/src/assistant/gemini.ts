import type { GeminiContent } from "./prompt.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** A failure the user can be told about; `detail` is for the server log only. */
export class AssistantError extends Error {
  constructor(
    readonly userMessage: string,
    readonly detail: string,
    readonly status = 502,
    /** Worth retrying (the model was overloaded or had an internal error) if nothing was sent yet. */
    readonly retryable = false,
    /** The model's quota is used up: for the day, or for `retryAfterSeconds`. */
    readonly quota?: { daily: boolean; retryAfterSeconds: number },
  ) {
    super(detail);
  }
}

/** Seconds until the next midnight in California, when Google resets daily quotas (plus a minute of margin). */
export function secondsUntilPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return 86_400 - (get("hour") * 3600 + get("minute") * 60 + get("second")) + 60;
}

export interface StreamOptions {
  apiKey: string;
  model: string;
  systemInstruction: { parts: { text: string }[] };
  contents: GeminiContent[];
  signal: AbortSignal;
}

interface GoogleError {
  error?: { status?: string; message?: string; details?: { violations?: { quotaId?: string }[]; retryDelay?: string }[] };
}

export function explainHttp(status: number, body: string): AssistantError {
  let reason = "";
  let parsed: GoogleError = {};
  try {
    parsed = JSON.parse(body) as GoogleError;
    reason = `${parsed.error?.status ?? ""} ${parsed.error?.message ?? ""}`.trim();
  } catch {
    reason = body.slice(0, 300);
  }
  if (status === 429) {
    const details = parsed.error?.details ?? [];
    const quotaIds = details.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? "");
    const delay = Number.parseFloat(details.find((d) => d.retryDelay)?.retryDelay ?? "");
    return new AssistantError("The assistant is getting a lot of requests right now. Please try again in a minute.", `429 ${quotaIds.join(",") || reason}`, 429, false, {
      daily: quotaIds.some((q) => /PerDay/i.test(q)),
      retryAfterSeconds: Number.isFinite(delay) ? Math.ceil(delay) : 60,
    });
  }
  if (status === 400 && /API key|API_KEY/i.test(reason)) return new AssistantError("The assistant isn't available right now.", `key rejected: ${reason}`, 503);
  if (status === 401 || status === 403) return new AssistantError("The assistant isn't available right now.", `${status} ${reason}`, 503);
  if (status === 400) return new AssistantError("The assistant couldn't process that request. Try asking about a smaller part of the code.", `400 ${reason}`, 400);
  return new AssistantError("The assistant is temporarily unavailable. Please try again.", `${status} ${reason}`, 502, status >= 500);
}

const STOP_MESSAGES: Record<string, string> = {
  SAFETY: "The assistant couldn't answer that request.",
  PROHIBITED_CONTENT: "The assistant couldn't answer that request.",
  BLOCKLIST: "The assistant couldn't answer that request.",
  RECITATION: "The answer was stopped because it matched existing published text too closely. Try rephrasing the question.",
};

export interface Chunk {
  kind: "text" | "thinking";
  text: string;
}

/**
 * Streams summaries of the model's reasoning and the answer text. Throws
 * AssistantError on HTTP errors, blocked answers or a stalled stream.
 */
export async function* streamAnswer(opts: StreamOptions): AsyncGenerator<Chunk> {
  const stall = new AbortController();
  const signal = AbortSignal.any([opts.signal, stall.signal]);
  let timer = setTimeout(() => stall.abort(), 45_000);
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), 45_000);
  };

  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify({
        systemInstruction: opts.systemInstruction,
        contents: opts.contents,
        generationConfig: {
          // Low temperature: explanations of code should be precise, not creative.
          temperature: 0.3,
          // Thinking counts toward this limit, so leave ample room for the answer after it.
          maxOutputTokens: 16_384,
          // High: answers are checked more carefully. Summaries of the reasoning are
          // streamed so the user sees progress while the model thinks.
          thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
        },
      }),
      signal,
    });
    if (!res.ok || !res.body) throw explainHttp(res.status, await res.text().catch(() => ""));

    const decoder = new TextDecoder();
    let buffer = "";
    let produced = false;
    let finish = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      kick();
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = JSON.parse(line.slice(5)) as {
          candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
          promptFeedback?: { blockReason?: string };
        };
        if (data.promptFeedback?.blockReason) {
          throw new AssistantError(STOP_MESSAGES.SAFETY!, `prompt blocked: ${data.promptFeedback.blockReason}`, 400);
        }
        const candidate = data.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          if (!part.text) continue;
          if (part.thought) {
            yield { kind: "thinking", text: part.text };
          } else {
            produced = true;
            yield { kind: "text", text: part.text };
          }
        }
        const reason = candidate?.finishReason;
        if (reason) finish = reason;
        if (reason && STOP_MESSAGES[reason]) throw new AssistantError(STOP_MESSAGES[reason], `finish ${reason}`, 400);
        if (reason === "MAX_TOKENS" && produced) yield { kind: "text", text: "\n\n*(The answer was cut off because it got too long. Ask me to continue.)*" };
      }
    }
    // Retryable: another model usually answers.
    if (!produced) throw new AssistantError("The assistant returned an empty answer. Please try again.", `empty answer (${finish || "no finish reason"})`, 502, true);
  } catch (e) {
    if (e instanceof AssistantError) throw e;
    if (stall.signal.aborted) throw new AssistantError("The assistant took too long to answer. Please try again.", "stream stalled", 504);
    if (opts.signal.aborted) throw e;
    throw new AssistantError("The assistant is temporarily unavailable. Please try again.", e instanceof Error ? e.message : String(e), 502);
  } finally {
    clearTimeout(timer);
  }
}
