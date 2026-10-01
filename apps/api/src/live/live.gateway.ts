import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { WebSocketGateway, type OnGatewayConnection } from "@nestjs/websockets";
import type { IncomingMessage } from "node:http";
import type { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { LIVE_LIMITS, isTerminalStatus, type LiveClientMessage, type LiveServerMessage } from "@cw/shared";
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
    this.rooms = new LiveRooms(
      new RedisLiveStore(redis),
      (m) => this.logger.warn(m),
      (id, data, eof) => executions.sendInput(id, data, eof),
      config.liveMaxRoomsPerClient,
      // An interview submission: the same sandboxed test run a browser would ask for, awaited here.
      async (request, client) => {
        const { id } = await executions.create(request, client);
        const deadline = Date.now() + JUDGE_TIMEOUT_MS;
        for (;;) {
          const result = await executions.get(id);
          if (isTerminalStatus(result.status)) return result;
          if (Date.now() > deadline) {
            await executions.cancel(id).catch(() => {});
            throw new Error("The tests took too long.");
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      },
    );
  }

  async onApplicationShutdown() {
    await this.rooms.saveAll();
  }
}

const JOIN_TIMEOUT_MS = 10_000;
const JUDGE_TIMEOUT_MS = 5 * 60_000;
const MAX_CONTROL_BYTES = 4096;
/** Messages that carry the interviewer's problem, hidden tests or notes may be larger (up to the frame limit). */
const LARGE_CONTROL = new Set<string>(["interview-setup", "interview-notes", "rtc"]);

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
    if (origin && !config.webOrigins.includes(origin)) {
      this.logger.warn(`live connection from an origin that is not allowed: ${origin.slice(0, 100)}`);
      return client.close(1008, "origin not allowed");
    }

    const send = (data: Uint8Array | string) => {
      if (client.readyState === client.OPEN) client.send(data);
    };
    const fail = (code: LiveError["code"], message: string) => {
      this.logger.warn(`live connection refused: ${code} (${message})`);
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
      let msg: LiveClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8")) as LiveClientMessage;
      } catch {
        return fail("invalid", "Invalid JSON.");
      }
      if (raw.length > MAX_CONTROL_BYTES && !(conn && LARGE_CONTROL.has(String(msg?.type)))) return fail("invalid", "Message too large.");
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

    client.on("close", (code: number, reason: Buffer) => {
      // Normal ends are not worth a line; anything else helps explain a "could not connect".
      if (![1000, 1001, 1005, LiveClose.ended, LiveClose.removed].includes(code)) this.logger.warn(`live socket closed: ${code} ${reason.toString("utf8").slice(0, 120)}${conn ? "" : " (before joining)"}`);
      closed = true;
      clearTimeout(joinTimer);
      conn?.close();
      conn = null;
    });
    client.on("error", (e) => this.logger.warn(`live socket error: ${e.message}`));
  }
}
