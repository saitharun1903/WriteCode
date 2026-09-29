import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { WebSocketGateway, type OnGatewayConnection } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { LIVE_LIMITS, type LiveClientMessage, type LiveServerMessage } from "@cw/shared";
import { config } from "../config.js";
import { REDIS } from "../infra/infra.module.js";
import { ExecutionsService } from "../executions/executions.service.js";
import { RedisLiveStore } from "./redis-store.js";
import { LiveClose, LiveError, LiveRooms, type LiveConnection } from "./rooms.js";

/** The rooms, shared by the gateway and the controller that creates sessions. */
@Injectable()
export class LiveService implements OnApplicationShutdown {
  private readonly logger = new Logger("Live");
  readonly rooms: LiveRooms;

  constructor(@Inject(REDIS) redis: Redis, executions: ExecutionsService) {
    // Typed input from people in a session goes to runs announced in it (checked by the rooms).
    this.rooms = new LiveRooms(new RedisLiveStore(redis), (m) => this.logger.warn(m), (id, data, eof) => executions.sendInput(id, data, eof), config.liveMaxRoomsPerClient);
  }

  async onApplicationShutdown() {
    await this.rooms.saveAll();
  }
}

const JOIN_TIMEOUT_MS = 10_000;
const MAX_CONTROL_BYTES = 4096;

const CLOSE_FOR: Record<LiveError["code"], number> = {
  "not-found": LiveClose.notFound,
  full: LiveClose.full,
  removed: LiveClose.removed,
  invalid: LiveClose.invalid,
  "too-large": LiveClose.invalid,
  rate: LiveClose.rate,
};

/**
 * Live sessions: `/ws-live`. The first message must be a JSON `join` naming the session;
 * after that binary frames carry the shared document and presence, and JSON
 * frames carry control messages (see LiveClientMessage in @cw/shared).
 */
@WebSocketGateway({ path: "/ws-live", maxPayload: LIVE_LIMITS.maxFrameBytes })
export class LiveGateway implements OnGatewayConnection {
  private readonly logger = new Logger("LiveGateway");

  constructor(private readonly live: LiveService) {}

  handleConnection(client: WebSocket, req: IncomingMessage) {
    const origin = req.headers.origin;
    if (origin && !config.webOrigins.includes(origin)) return client.close(1008, "origin not allowed");

    const send = (data: Uint8Array | string) => {
      if (client.readyState === client.OPEN) client.send(data);
    };
    const fail = (code: LiveError["code"], message: string) => {
      send(JSON.stringify({ type: "error", code, message } satisfies LiveServerMessage));
      client.close(CLOSE_FOR[code], message.slice(0, 120));
    };

    let conn: LiveConnection | null = null;
    let joining = false;
    let closed = false;
    const joinTimer = setTimeout(() => !conn && client.close(LiveClose.invalid, "no join"), JOIN_TIMEOUT_MS);
    let windowStart = Date.now();
    let frames = 0;

    client.on("message", (raw: Buffer, isBinary: boolean) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        frames = 0;
      }
      if (++frames > LIVE_LIMITS.maxFramesPerSecond) return fail("rate", "Too many messages; slow down.");

      if (isBinary) {
        if (!conn) return;
        try {
          conn.binary(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        } catch (e) {
          this.logger.warn(`bad live frame: ${String(e)}`);
          fail("invalid", "Invalid message.");
        }
        return;
      }
      if (raw.length > MAX_CONTROL_BYTES) return fail("invalid", "Message too large.");
      let msg: LiveClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8")) as LiveClientMessage;
      } catch {
        return fail("invalid", "Invalid JSON.");
      }
      if (!conn) {
        if (joining || msg?.type !== "join") return;
        joining = true;
        this.live.rooms
          .join(String(msg.room ?? ""), { send, close: (code, reason) => client.close(code, reason) }, msg)
          .then((c) => {
            clearTimeout(joinTimer);
            // The socket may have closed while the session was loading.
            if (closed) return c.close();
            conn = c;
          })
          .catch((e: unknown) => {
            if (e instanceof LiveError) return fail(e.code, e.message);
            this.logger.error(`live join failed: ${String(e)}`);
            fail("not-found", "Live sessions are unavailable right now. Try again shortly.");
          });
        return;
      }
      void conn.control(msg).catch((e: unknown) => this.logger.error(`live control failed: ${String(e)}`));
    });

    client.on("close", () => {
      closed = true;
      clearTimeout(joinTimer);
      conn?.close();
      conn = null;
    });
    client.on("error", (e) => this.logger.warn(`live socket error: ${e.message}`));
  }
}
