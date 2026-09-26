import { Logger } from "@nestjs/common";
import { WebSocketGateway, type OnGatewayConnection } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import { DEBUG_LIMITS, REQUEST_BOUNDS, parseDebugCommand, utf8ByteLength } from "@cw/shared";
import { clientHash, clientIp } from "../common/request-context.js";
import { ExecutionStore } from "../executions/execution-store.js";
import { ExecutionsService, assertExecutionId } from "../executions/executions.service.js";
import { StreamHub } from "./stream-hub.js";

const MAX_MESSAGE_BYTES = 4096;
/** How long a live session survives with nobody watching (covers quick reconnects). */
const ORPHAN_GRACE_MS = 5000;
/** Debug commands and input messages allowed per connection per second. */
const MAX_COMMANDS_PER_SECOND = 30;

/**
 * Live execution events. Protocol: the client sends
 * `{"type":"subscribe","executionId":"<uuid>"}` and receives
 * ExecutionStreamEvent JSON messages, ending with a `result` event.
 * The creator of an execution may also send
 * `{"type":"debug","executionId","requestId","command"}` and
 * `{"type":"stdin","executionId","data","eof"}` (typed input).
 */
@WebSocketGateway({ path: "/ws" })
export class StreamGateway implements OnGatewayConnection {
  private readonly logger = new Logger(StreamGateway.name);

  constructor(
    private readonly hub: StreamHub,
    private readonly store: ExecutionStore,
    private readonly executions: ExecutionsService,
  ) {}

  handleConnection(client: WebSocket, req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin && !config.webOrigins.includes(origin)) {
      client.close(1008, "origin not allowed");
      return;
    }

    // The same client identity the REST API used when the execution was created.
    const owner = clientHash(clientIp(req));
    const unsubscribers = new Set<() => void>();
    const followed = new Set<string>();
    let windowStart = Date.now();
    let commandsInWindow = 0;
    const sendJson = (payload: unknown) => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
    };

    client.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary || raw.length > MAX_MESSAGE_BYTES) return client.close(1009, "message too large");
      let msg: { type?: unknown; executionId?: unknown; requestId?: unknown; command?: unknown; data?: unknown; eof?: unknown };
      try {
        msg = JSON.parse(raw.toString("utf8")) as typeof msg;
      } catch {
        return sendJson({ type: "error", message: "Invalid JSON." });
      }
      if (msg.type === "debug" || msg.type === "stdin") {
        const now = Date.now();
        if (now - windowStart > 1000) {
          windowStart = now;
          commandsInWindow = 0;
        }
        if (++commandsInWindow > MAX_COMMANDS_PER_SECOND) return sendJson({ type: "error", message: "Too many messages." });
        return void (msg.type === "debug" ? this.debug(msg, owner, sendJson) : this.stdin(msg, owner, sendJson));
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
      followed.add(executionId);
      void this.subscribe(executionId, sendJson, unsubscribers);
    });

    client.on("close", () => {
      for (const u of unsubscribers) u();
      unsubscribers.clear();
      // A debug session nobody is watching would hold a sandbox until it times out; end it.
      for (const id of followed) {
        setTimeout(() => {
          if (this.hub.subscribers(id) > 0) return;
          void this.executions.sendDebugCommand(id, "orphaned", { cmd: "terminate" }).catch(() => {});
        }, ORPHAN_GRACE_MS);
      }
    });
    client.on("error", (e) => this.logger.warn(`socket error: ${e.message}`));
  }

  private async stdin(msg: { executionId?: unknown; data?: unknown; eof?: unknown }, client: string, sendJson: (p: unknown) => void) {
    const { executionId, data, eof } = msg;
    if (typeof executionId !== "string" || typeof data !== "string" || (eof !== undefined && typeof eof !== "boolean")) {
      return sendJson({ type: "error", message: "Invalid input message." });
    }
    if (utf8ByteLength(data) > REQUEST_BOUNDS.maxInputChunkBytes) {
      return sendJson({ type: "input-error", executionId, message: `Send at most ${REQUEST_BOUNDS.maxInputChunkBytes} bytes at a time.` });
    }
    try {
      assertExecutionId(executionId);
    } catch {
      return sendJson({ type: "error", message: "Invalid execution id." });
    }
    if (!(await this.executions.isOwner(executionId, client).catch(() => false))) {
      return sendJson({ type: "input-error", executionId, message: "Only the browser that started this program can send it input." });
    }
    const error = await this.executions.sendInput(executionId, data, eof === true).catch(() => "The execution service is unavailable.");
    if (error) sendJson({ type: "input-error", executionId, message: error });
  }

  private async debug(msg: { executionId?: unknown; requestId?: unknown; command?: unknown }, client: string, sendJson: (p: unknown) => void) {
    const { executionId, requestId } = msg;
    if (typeof executionId !== "string" || typeof requestId !== "string" || requestId.length > DEBUG_LIMITS.maxRequestIdLength) {
      return sendJson({ type: "error", message: "Invalid debug message." });
    }
    try {
      assertExecutionId(executionId);
    } catch {
      return sendJson({ type: "error", message: "Invalid execution id." });
    }
    const command = parseDebugCommand(msg.command);
    if (!command) return sendJson({ type: "debug-error", executionId, requestId, message: "Invalid debug command." });
    if (!(await this.executions.isOwner(executionId, client).catch(() => false))) {
      return sendJson({ type: "debug-error", executionId, requestId, message: "Only the browser that started this session can control it." });
    }
    const error = await this.executions.sendDebugCommand(executionId, requestId, command).catch(() => "The debug service is unavailable.");
    if (error) sendJson({ type: "debug-error", executionId, requestId, message: error });
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
