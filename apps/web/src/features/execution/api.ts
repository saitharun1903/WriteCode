import type { DebugCommand, ExecutionRequest, ExecutionResult, ExecutionStreamEvent, LanguageDefinition } from "@cw/shared";

/**
 * Public base URL of the API. Not a secret. Production builds default to the
 * page's own origin (the reverse proxy serves the site and the API together);
 * development defaults to the local API server.
 */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:4000")).replace(/\/$/, "");

/** WebSocket endpoint: wss:// on HTTPS pages. */
function wsUrl(): string {
  if (API_URL) return `${API_URL.replace(/^http/, "ws")}/ws`;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

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
  services: { redis: "up" | "down"; database: "up" | "down" };
  runner: { available: boolean; workers: number; reason?: string };
  languages: (Pick<LanguageDefinition, "id" | "name" | "version" | "supportLevel"> & { ready: boolean })[];
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>("/api/v1/health", { signal }),
  createExecution: (body: ExecutionRequest) =>
    request<{ id: string; controlToken: string }>("/api/v1/executions", { method: "POST", body: JSON.stringify(body) }),
  getExecution: (id: string) => request<ExecutionResult>(`/api/v1/executions/${encodeURIComponent(id)}`),
  cancelExecution: (id: string) =>
    request<{ ok: true }>(`/api/v1/executions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
};

export interface ExecutionStream {
  close: () => void;
  /** Sends a debug command; resolves false if the socket is not open. */
  sendDebug: (requestId: string, command: DebugCommand) => boolean;
  /** Sends typed input to the running program; `eof` closes its stdin. False if the socket is not open. */
  sendInput: (data: string, eof?: boolean) => boolean;
}

/**
 * Subscribes to the live event stream of one execution. The server replays
 * events already emitted, so subscribing after the POST cannot miss output.
 * The same socket carries debug commands for debug sessions.
 */
export function streamExecution(
  executionId: string,
  /** Proves this browser created the execution; required for debug commands and typed input. */
  controlToken: string,
  handlers: {
    onEvent: (e: ExecutionStreamEvent) => void;
    onError: (message: string) => void;
    onDebugError?: (requestId: string, message: string) => void;
    onInputError?: (message: string) => void;
  },
): ExecutionStream {
  const ws = new WebSocket(wsUrl());
  let done = false;

  ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", executionId }));
  ws.onmessage = (msg) => {
    let event:
      | ExecutionStreamEvent
      | { type: "debug-error"; executionId: string; requestId: string; message: string }
      | { type: "input-error"; executionId: string; message: string };
    try {
      event = JSON.parse(String(msg.data)) as typeof event;
    } catch {
      return;
    }
    if (event.executionId !== executionId) return;
    if (event.type === "debug-error") return handlers.onDebugError?.(event.requestId, event.message);
    if (event.type === "input-error") return handlers.onInputError?.(event.message);
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

  return {
    close: () => {
      done = true;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    },
    sendDebug: (requestId, command) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type: "debug", executionId, token: controlToken, requestId, command }));
      return true;
    },
    sendInput: (data, eof = false) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ type: "stdin", executionId, token: controlToken, data, eof }));
      return true;
    },
  };
}
