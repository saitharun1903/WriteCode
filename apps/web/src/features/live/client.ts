"use client";

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { LiveFrame, type LiveClientMessage, type LiveServerMessage } from "@cw/shared";
import { API_URL } from "@/features/execution/api";

export type LiveStatus = "connecting" | "connected" | "reconnecting" | "closed";

/** Close codes after which reconnecting cannot help (see LiveClose on the server). */
const FINAL_CLOSE = new Set([1008, 4000, 4001, 4004, 4008, 4400, 4429]);

function liveUrl(): string {
  const base = API_URL ? API_URL.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base}/ws-live`;
}

export interface LiveClientOptions {
  roomId: string;
  name: string;
  clientKey: string;
  ownerToken?: string;
  onMessage: (message: LiveServerMessage) => void;
  onStatus: (status: LiveStatus, closeCode?: number) => void;
  /** The shared document has caught up with the server (after each (re)connect). */
  onSynced: () => void;
}

/**
 * One participant's connection to a live session: the shared document, this
 * person's presence and the control channel. Reconnects with backoff after a
 * network drop; the Yjs sync exchange then merges anything edited meanwhile.
 */
export class LiveClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** Changes received from the server carry this origin; everything else is ours to send. */
  readonly remote = Symbol("remote");
  private ws: WebSocket | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private canWrite = false;

  constructor(private readonly opts: LiveClientOptions) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this.remote || !this.canWrite) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, LiveFrame.sync);
      syncProtocol.writeUpdate(enc, update);
      this.sendBinary(encoding.toUint8Array(enc));
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this.remote) return;
      const mine = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (!mine.length) return;
      this.sendPresence(mine);
    });
  }

  /** Opens the connection. Separate from the constructor so callers can store the client first. */
  start() {
    if (!this.ws && !this.stopped) this.connect();
  }

  /** Viewers keep a read-only copy: their document changes are never sent. */
  setWritable(writable: boolean) {
    this.canWrite = writable;
  }

  /** False when not connected (the message is not sent). */
  send(message: LiveClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private sendBinary(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data as Uint8Array<ArrayBuffer>);
  }

  private sendPresence(ids: number[]) {
    if (!this.awareness.getLocalState()) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, LiveFrame.awareness);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids));
    this.sendBinary(encoding.toUint8Array(enc));
  }

  private connect() {
    this.opts.onStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(liveUrl());
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", room: this.opts.roomId, name: this.opts.name, clientKey: this.opts.clientKey, ownerToken: this.opts.ownerToken } satisfies LiveClientMessage));
    };
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data === "string") {
        let msg: LiveServerMessage;
        try {
          msg = JSON.parse(e.data) as LiveServerMessage;
        } catch {
          return;
        }
        if (msg.type === "welcome") {
          this.attempts = 0;
          this.opts.onStatus("connected");
          // Ask for anything the server has that we lack; its reply also brings our offline edits to it.
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, LiveFrame.sync);
          syncProtocol.writeSyncStep1(enc, this.doc);
          this.sendBinary(encoding.toUint8Array(enc));
        }
        this.opts.onMessage(msg);
        if (msg.type === "welcome" && this.awareness.getLocalState()) this.sendPresence([this.doc.clientID]);
        return;
      }
      const decoder = decoding.createDecoder(new Uint8Array(e.data));
      const frame = decoding.readVarUint(decoder);
      if (frame === LiveFrame.sync) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, LiveFrame.sync);
        const kind = syncProtocol.readSyncMessage(decoder, reply, this.doc, this.remote);
        // The server's request for our state: answer only if we may write.
        if (encoding.length(reply) > 1 && this.canWrite) this.sendBinary(encoding.toUint8Array(reply));
        if (kind === syncProtocol.messageYjsSyncStep2) this.opts.onSynced();
      } else if (frame === LiveFrame.awareness) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this.remote);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Other people's cursors are stale until we are back.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this.remote);
      if (this.stopped || FINAL_CLOSE.has(e.code)) {
        this.stopped = true;
        this.opts.onStatus("closed", e.code);
        return;
      }
      const delay = Math.min(10_000, 500 * 2 ** this.attempts++) * (0.75 + Math.random() * 0.5);
      this.opts.onStatus("reconnecting");
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Reconnects now (after the browser comes back online). */
  retryNow() {
    if (this.stopped || this.ws) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connect();
  }

  destroy() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.ws?.close(1000);
    this.ws = null;
    this.awareness.destroy();
    this.doc.destroy();
  }
}
