import { Logger } from "@nestjs/common";
import { WebSocketGateway, type OnGatewayConnection } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import { ExecutionStore } from "../executions/execution-store.js";
import { assertExecutionId } from "../executions/executions.service.js";
import { StreamHub } from "./stream-hub.js";

const MAX_MESSAGE_BYTES = 1024;

/**
 * Live execution events. Protocol: the client sends
 * `{"type":"subscribe","executionId":"<uuid>"}` and receives
 * ExecutionStreamEvent JSON messages, ending with a `result` event.
 */
@WebSocketGateway({ path: "/ws" })
export class StreamGateway implements OnGatewayConnection {
  private readonly logger = new Logger(StreamGateway.name);

  constructor(
    private readonly hub: StreamHub,
    private readonly store: ExecutionStore,
  ) {}

  handleConnection(client: WebSocket, req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin && !config.webOrigins.includes(origin)) {
      client.close(1008, "origin not allowed");
      return;
    }

    const unsubscribers = new Set<() => void>();
    const sendJson = (payload: unknown) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
    };

    client.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary || raw.length > MAX_MESSAGE_BYTES) return client.close(1009, "message too large");
      let msg: { type?: unknown; executionId?: unknown };
      try {
        msg = JSON.parse(raw.toString("utf8")) as typeof msg;
      } catch {
        return sendJson({ type: "error", message: "Invalid JSON." });
      }
      if (msg.type !== "subscribe" || typeof msg.executionId !== "string") {
        return sendJson({ type: "error", message: "Unknown message." });
      }
      if (unsubscribers.size >= config.maxSubscriptionsPerSocket) {
        return sendJson({ type: "error", message: "Too many subscriptions on this connection." });
      }
      const executionId = msg.executionId;
      try {
        assertExecutionId(executionId);
      } catch {
        return sendJson({ type: "error", message: "Invalid execution id." });
      }
      void this.subscribe(executionId, sendJson, unsubscribers);
    });

    client.on("close", () => {
      for (const u of unsubscribers) u();
      unsubscribers.clear();
    });
    client.on("error", (e) => this.logger.warn(`socket error: ${e.message}`));
  }

  private async subscribe(executionId: string, sendJson: (p: unknown) => void, unsubscribers: Set<() => void>) {
    const result = await this.store.getResult(executionId).catch(() => null);
    if (!result) return sendJson({ type: "error", executionId, message: "Execution not found." });
    // Streams expire after an hour; serve old executions straight from the durable record.
    const hasStream = await this.store.hasEvents(executionId);
    if (!hasStream) return sendJson({ type: "result", executionId, result });
    const unsubscribe = this.hub.subscribe(executionId, { send: sendJson });
    unsubscribers.add(unsubscribe);
  }
}
