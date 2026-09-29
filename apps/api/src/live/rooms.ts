import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  LIVE_CLIENT_KEY,
  LIVE_COLORS,
  LIVE_LIMITS,
  LiveFrame,
  isLiveRoomId,
  type LiveClientMessage,
  type LiveJoinRole,
  type LiveParticipant,
  type LiveRole,
  type LiveRunNotice,
  type LiveServerMessage,
} from "@cw/shared";

/** What is kept about a session between server restarts (never the owner token itself). */
export interface RoomMeta {
  id: string;
  ownerTokenHash: string;
  client: string;
  createdAt: number;
  defaultRole: LiveJoinRole;
  /** Roles the owner gave particular people, by their browser key. */
  roles: Record<string, LiveJoinRole>;
  /** Browser keys of people the owner removed; they cannot rejoin. */
  removed: string[];
  ended?: boolean;
}

export interface LiveStore {
  getMeta(id: string): Promise<RoomMeta | null>;
  putMeta(meta: RoomMeta): Promise<void>;
  getDoc(id: string): Promise<Uint8Array | null>;
  putDoc(id: string, state: Uint8Array): Promise<void>;
  deleteDoc(id: string): Promise<void>;
  /** Sessions this client created that are still open. */
  openRooms(client: string): Promise<number>;
  addRoom(client: string, id: string): Promise<void>;
  removeRoom(client: string, id: string): Promise<void>;
}

/** One WebSocket, as the rooms see it. */
export interface LivePeer {
  send(data: Uint8Array | string): void;
  close(code: number, reason: string): void;
}

export const LiveClose = { ended: 4000, removed: 4001, notFound: 4004, full: 4008, invalid: 4400, rate: 4429 } as const;

export class LiveError extends Error {
  constructor(
    readonly code: Extract<LiveServerMessage, { type: "error" }>["code"],
    message: string,
  ) {
    super(message);
  }
}

interface Member {
  id: string;
  peer: LivePeer;
  name: string;
  role: LiveRole;
  color: number;
  clientKey: string;
  /** Presence entries this connection publishes; only it may change or remove them. */
  awarenessIds: Set<number>;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();
const SAVE_DELAY_MS = 2000;
const UNLOAD_DELAY_MS = 60_000;

export function cleanName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim() : "";
  return name.slice(0, LIVE_LIMITS.maxNameLength) || "Guest";
}

class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly members = new Map<string, Member>();
  lastRun?: LiveRunNotice;
  /** The document reached its size limit; further edits are refused. */
  full = false;
  private approxBytes = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  unloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public meta: RoomMeta,
    private readonly store: LiveStore,
    private readonly onError: (message: string) => void,
  ) {
    // The server takes part in presence only as a relay.
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, LiveFrame.sync);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin as Member | undefined);
      this.approxBytes += update.length;
      if (this.approxBytes > LIVE_LIMITS.maxDocBytes) this.checkSize();
      this.scheduleSave();
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const member = origin instanceof Object && "awarenessIds" in origin ? (origin as Member) : undefined;
      if (member) for (const id of added) member.awarenessIds.add(id);
      const changed = [...added, ...updated, ...removed];
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, LiveFrame.awareness);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(encoder), member);
    });
  }

  load(state: Uint8Array) {
    Y.applyUpdate(this.doc, state, "storage");
    this.approxBytes = state.length;
  }

  private checkSize() {
    this.approxBytes = Y.encodeStateAsUpdate(this.doc).length;
    if (this.approxBytes <= LIVE_LIMITS.maxDocBytes || this.full) return;
    this.full = true;
    this.sendAll({ type: "error", code: "too-large", message: "This project has reached the size limit for live sessions; new changes are not shared." });
  }

  broadcast(data: Uint8Array | string, except?: Member) {
    for (const m of this.members.values()) if (m !== except) m.peer.send(data);
  }

  sendAll(message: LiveServerMessage) {
    this.broadcast(JSON.stringify(message));
  }

  participants(): LiveParticipant[] {
    return [...this.members.values()].map(({ id, name, role, color }) => ({ id, name, role, color }));
  }

  scheduleSave() {
    this.saveTimer ??= setTimeout(() => void this.save(), SAVE_DELAY_MS);
  }

  async save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.meta.ended) return;
    try {
      await this.store.putDoc(this.meta.id, Y.encodeStateAsUpdate(this.doc));
      await this.store.putMeta(this.meta);
    } catch (e) {
      this.onError(`could not save live session: ${String(e)}`);
    }
  }

  destroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.awareness.destroy();
    this.doc.destroy();
  }
}

/**
 * Live sessions held in memory while someone is connected, saved to storage
 * (debounced) so they survive a server restart. Framework-free so it can be
 * tested with plain objects.
 */
export class LiveRooms {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room | null>>();
  private nextMember = 0;

  constructor(
    private readonly store: LiveStore,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Starts a session. The owner token is returned once and only its hash is kept. */
  async create(client: string): Promise<{ id: string; ownerToken: string }> {
    if ((await this.store.openRooms(client)) >= LIVE_LIMITS.maxRoomsPerClient) {
      throw new LiveError("rate", `You can have ${LIVE_LIMITS.maxRoomsPerClient} live sessions open at once. End one to start another.`);
    }
    const id = randomBytes(18).toString("base64url");
    const ownerToken = randomBytes(24).toString("base64url");
    const meta: RoomMeta = { id, ownerTokenHash: sha256(ownerToken).toString("hex"), client, createdAt: Date.now(), defaultRole: "editor", roles: {}, removed: [] };
    await this.store.putMeta(meta);
    await this.store.addRoom(client, id);
    return { id, ownerToken };
  }

  private room(id: string): Promise<Room | null> {
    const loaded = this.rooms.get(id);
    if (loaded) return Promise.resolve(loaded);
    let pending = this.loading.get(id);
    if (!pending) {
      pending = (async () => {
        const meta = await this.store.getMeta(id);
        if (!meta || meta.ended) return null;
        const room = new Room(meta, this.store, this.log);
        const state = await this.store.getDoc(id);
        if (state) room.load(state);
        this.rooms.set(id, room);
        return room;
      })().finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  /**
   * Adds a connection to a session after its `join` message. Sends the welcome,
   * the document and everyone's presence. Returns a handle for later messages.
   */
  async join(roomId: string, peer: LivePeer, msg: Extract<LiveClientMessage, { type: "join" }>): Promise<LiveConnection> {
    if (!isLiveRoomId(roomId)) throw new LiveError("not-found", "This live session link is not valid.");
    if (typeof msg.clientKey !== "string" || !LIVE_CLIENT_KEY.test(msg.clientKey)) throw new LiveError("invalid", "Invalid join message.");
    const room = await this.room(roomId);
    if (!room) throw new LiveError("not-found", "This live session has ended or the link is wrong.");
    if (room.unloadTimer) {
      clearTimeout(room.unloadTimer);
      room.unloadTimer = null;
    }
    const owner = typeof msg.ownerToken === "string" && msg.ownerToken.length <= 64 && timingSafeEqual(sha256(msg.ownerToken), Buffer.from(room.meta.ownerTokenHash, "hex"));
    if (!owner && room.meta.removed.includes(msg.clientKey)) throw new LiveError("removed", "The owner removed you from this session.");
    if (room.members.size >= LIVE_LIMITS.maxParticipants) throw new LiveError("full", `This session is full (${LIVE_LIMITS.maxParticipants} people).`);

    const used = new Map<number, number>();
    for (const m of room.members.values()) used.set(m.color, (used.get(m.color) ?? 0) + 1);
    const color = [...LIVE_COLORS.keys()].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0) || a - b)[0]!;
    const member: Member = {
      id: `p${++this.nextMember}`,
      peer,
      name: cleanName(msg.name),
      role: owner ? "owner" : (room.meta.roles[msg.clientKey] ?? room.meta.defaultRole),
      color,
      clientKey: msg.clientKey,
      awarenessIds: new Set(),
    };
    room.members.set(member.id, member);

    const send = (m: LiveServerMessage) => peer.send(JSON.stringify(m));
    send({ type: "welcome", you: { id: member.id, name: member.name, role: member.role, color }, defaultRole: room.meta.defaultRole, participants: room.participants(), run: room.lastRun });
    room.sendAll({ type: "participants", participants: room.participants() });
    // The document: our state vector (the client answers with what we lack) and everything we have.
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, LiveFrame.sync);
    syncProtocol.writeSyncStep1(step1, room.doc);
    peer.send(encoding.toUint8Array(step1));
    const step2 = encoding.createEncoder();
    encoding.writeVarUint(step2, LiveFrame.sync);
    syncProtocol.writeSyncStep2(step2, room.doc);
    peer.send(encoding.toUint8Array(step2));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, LiveFrame.awareness);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      peer.send(encoding.toUint8Array(enc));
    }
    return new LiveConnection(this, room, member);
  }

  /** Called when a connection closes. */
  leave(room: Room, member: Member) {
    if (!room.members.delete(member.id)) return;
    if (member.awarenessIds.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...member.awarenessIds], null);
    room.sendAll({ type: "participants", participants: room.participants() });
    if (room.members.size === 0 && !room.meta.ended) {
      room.unloadTimer = setTimeout(() => {
        if (room.members.size > 0) return;
        void room.save().finally(() => {
          if (room.members.size > 0 || this.rooms.get(room.meta.id) !== room) return;
          this.rooms.delete(room.meta.id);
          room.destroy();
        });
      }, UNLOAD_DELAY_MS);
    }
  }

  async end(room: Room) {
    room.meta.ended = true;
    room.sendAll({ type: "ended" });
    for (const m of room.members.values()) m.peer.close(LiveClose.ended, "session ended");
    room.members.clear();
    this.rooms.delete(room.meta.id);
    room.destroy();
    await this.store.putMeta(room.meta);
    await this.store.deleteDoc(room.meta.id);
    await this.store.removeRoom(room.meta.client, room.meta.id);
  }

  /** Saves every open session (on shutdown). */
  async saveAll() {
    await Promise.all([...this.rooms.values()].map((r) => r.save()));
  }

  /** For tests and health: sessions currently in memory. */
  get loaded(): number {
    return this.rooms.size;
  }
}

const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_MODES = new Set(["run", "debug", "visualize"]);

/** One person's connection to a session. */
export class LiveConnection {
  constructor(
    private readonly rooms: LiveRooms,
    private readonly room: Room,
    private readonly member: Member,
  ) {}

  get role(): LiveRole {
    return this.member.role;
  }

  private send(message: LiveServerMessage) {
    this.member.peer.send(JSON.stringify(message));
  }

  /** Document and presence frames. */
  binary(data: Uint8Array) {
    const room = this.room;
    const decoder = decoding.createDecoder(data);
    const frame = decoding.readVarUint(decoder);
    if (frame === LiveFrame.sync) {
      const kind = decoding.peekVarUint(decoder);
      // Viewers may ask for the document but not change it.
      if (kind !== syncProtocol.messageYjsSyncStep1 && (this.member.role === "viewer" || room.full)) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, LiveFrame.sync);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, this.member);
      if (encoding.length(encoder) > 1) this.member.peer.send(encoding.toUint8Array(encoder));
    } else if (frame === LiveFrame.awareness) {
      const update = decoding.readVarUint8Array(decoder);
      if (!this.ownsPresence(update)) return;
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, this.member);
    }
  }

  /**
   * A presence update may only touch entries this connection created (or new
   * ones), must be small, and must name this connection as its user, so nobody
   * can move another person's cursor or pose as them.
   */
  private ownsPresence(update: Uint8Array): boolean {
    if (update.length > LIVE_LIMITS.maxAwarenessBytes) return false;
    try {
      const decoder = decoding.createDecoder(update);
      const count = decoding.readVarUint(decoder);
      if (count > 4) return false;
      for (let i = 0; i < count; i++) {
        const clientId = decoding.readVarUint(decoder);
        decoding.readVarUint(decoder); // clock
        const state = JSON.parse(decoding.readVarString(decoder)) as { user?: { id?: unknown } } | null;
        for (const other of this.room.members.values()) {
          if (other !== this.member && other.awarenessIds.has(clientId)) return false;
        }
        if (state !== null && state.user?.id !== this.member.id) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Control messages. Returns false when the connection should be closed. */
  async control(msg: LiveClientMessage): Promise<void> {
    const room = this.room;
    const me = this.member;
    const owner = me.role === "owner";
    switch (msg.type) {
      case "rename":
        me.name = cleanName(msg.name);
        room.sendAll({ type: "participants", participants: room.participants() });
        return;
      case "run": {
        if (me.role === "viewer" || !EXECUTION_ID.test(String(msg.executionId)) || !RUN_MODES.has(msg.mode)) return;
        const entry = typeof msg.entry === "string" ? msg.entry.slice(0, 200) : "";
        room.lastRun = { executionId: msg.executionId, mode: msg.mode, entry, by: { id: me.id, name: me.name } };
        room.broadcast(JSON.stringify({ type: "run", run: room.lastRun } satisfies LiveServerMessage), me);
        return;
      }
      case "set-role": {
        if (!owner || (msg.role !== "editor" && msg.role !== "viewer")) return;
        const target = room.members.get(String(msg.id));
        if (!target || target.role === "owner") return;
        room.meta.roles[target.clientKey] = msg.role;
        // The same person may be connected from several tabs.
        for (const m of room.members.values()) {
          if (m.clientKey !== target.clientKey || m.role === "owner") continue;
          m.role = msg.role;
          m.peer.send(JSON.stringify({ type: "role", role: msg.role } satisfies LiveServerMessage));
        }
        room.sendAll({ type: "participants", participants: room.participants() });
        room.scheduleSave();
        return;
      }
      case "default-role":
        if (!owner || (msg.role !== "editor" && msg.role !== "viewer")) return;
        room.meta.defaultRole = msg.role;
        room.sendAll({ type: "default-role", role: msg.role });
        room.scheduleSave();
        return;
      case "remove": {
        if (!owner) return;
        const target = room.members.get(String(msg.id));
        if (!target || target.role === "owner") return;
        if (!room.meta.removed.includes(target.clientKey)) room.meta.removed.push(target.clientKey);
        for (const m of [...room.members.values()]) {
          if (m.clientKey !== target.clientKey || m.role === "owner") continue;
          m.peer.send(JSON.stringify({ type: "removed" } satisfies LiveServerMessage));
          m.peer.close(LiveClose.removed, "removed by the owner");
          this.rooms.leave(room, m);
        }
        room.scheduleSave();
        return;
      }
      case "end":
        if (owner) await this.rooms.end(room);
        return;
      default:
        this.send({ type: "error", code: "invalid", message: "Unknown message." });
    }
  }

  close() {
    this.rooms.leave(this.room, this.member);
  }
}
