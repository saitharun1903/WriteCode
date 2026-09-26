import type { ExecutionRequest, ExecutionResult, ExecutionStreamEvent, LanguageDefinition } from "@cw/shared";

/** Public base URL of the API. Not a secret; defaults to the local dev server. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const WS_URL = API_URL.replace(/^http/, "ws");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch {
    throw new ApiError("The execution service is unreachable.", 0);
  }
  const requestId = res.headers.get("x-request-id") ?? undefined;
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body.message) message = Array.isArray(body.message) ? body.message.join(", ") : body.message;
    } catch {}
    throw new ApiError(message, res.status, requestId);
  }
  return (await res.json()) as T;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  runner: { available: boolean; reason?: string };
  languages: Pick<LanguageDefinition, "id" | "name" | "version">[];
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>("/api/v1/health", { signal }),
  createExecution: (body: ExecutionRequest) =>
    request<{ id: string }>("/api/v1/executions", { method: "POST", body: JSON.stringify(body) }),
  getExecution: (id: string) => request<ExecutionResult>(`/api/v1/executions/${encodeURIComponent(id)}`),
  cancelExecution: (id: string) =>
    request<{ ok: true }>(`/api/v1/executions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};

/**
 * Subscribes to the live event stream of one execution. The server replays
 * events already emitted, so subscribing after the POST cannot miss output.
 * Returns an unsubscribe function.
 */
export function streamExecution(
  executionId: string,
  handlers: { onEvent: (e: ExecutionStreamEvent) => void; onError: (message: string) => void },
): () => void {
  const ws = new WebSocket(`${WS_URL}/ws`);
  let done = false;

  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", executionId }));
  ws.onmessage = (msg) => {
    let event: ExecutionStreamEvent;
    try {
      event = JSON.parse(String(msg.data)) as ExecutionStreamEvent;
    } catch {
      return;
    }
    if (event.executionId !== executionId) return;
    handlers.onEvent(event);
    if (event.type === "result") {
      done = true;
      ws.close();
    }
  };
  const fail = () => {
    if (done) return;
    done = true;
    handlers.onError("Lost connection to the execution stream.");
  };
  ws.onerror = fail;
  ws.onclose = (e) => {
    if (e.code !== 1000) fail();
    done = true;
  };

  return () => {
    done = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
  };
}
