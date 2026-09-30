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
  REQUEST_BOUNDS,
  TEST_LIMITS,
  utf8ByteLength,
  isLiveRoomId,
  CANDIDATE_EVENTS,
  INTERVIEW_LIMITS,
  cleanInterviewSetup,
  type InterviewEvent,
  type InterviewPrivate,
  type InterviewPublic,
  type InterviewSetup,
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
  /** Interview sessions: the problem and clock (public), and what only the interviewer sees. */
  interview?: { public: InterviewPublic; private: InterviewPrivate };
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
  /** Interview typing history: each document update with its time. */
  getHistory(id: string): Promise<[number, Uint8Array][] | null>;
  putHistory(id: string, history: [number, Uint8Array][]): Promise<void>;
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
  /** Interview: when this candidate left the tab / window, to report how long they were away. */
  awaySince?: { tab?: number; window?: number };
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
  /** Runs announced in this session (most recent last), so typed input can be relayed to them. */
  readonly runs = new Map<string, { interactive: boolean }>();
  /** The document reached its size limit; further edits are refused. */
  full = false;
  private approxBytes = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  unloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Interview: every document update with its time, for replay. */
  history: [number, Uint8Array][] = [];
  private historyBytes = 0;
  private historyDirty = false;
  private clockTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (this.meta.interview && origin !== "storage" && this.historyBytes + update.length <= INTERVIEW_LIMITS.maxHistoryBytes) {
        this.history.push([Date.now(), update]);
        this.historyBytes += update.length;
        this.historyDirty = true;
      }
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

  loadHistory(history: [number, Uint8Array][]) {
    this.history = history;
    this.historyBytes = history.reduce((n, [, u]) => n + u.length, 0);
  }

  // ---- Interview.

  get owners(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "owner");
  }

  /** Sends the interviewer-only state to the interviewer's connections. */
  sendPrivate() {
    const iv = this.meta.interview;
    if (!iv) return;
    for (const m of this.owners) m.peer.send(JSON.stringify({ type: "interview-private", state: iv.private } satisfies LiveServerMessage));
  }

  sendPublic() {
    if (this.meta.interview) this.sendAll({ type: "interview", state: this.meta.interview.public });
  }

  /** Adds an entry to the activity log and shows it to the interviewer as it happens. */
  log(event: Omit<InterviewEvent, "t">) {
    const iv = this.meta.interview;
    if (!iv) return;
    const entry: InterviewEvent = { t: Date.now(), ...event };
    iv.private.events.push(entry);
    if (iv.private.events.length > INTERVIEW_LIMITS.maxEvents) iv.private.events.splice(0, iv.private.events.length - INTERVIEW_LIMITS.maxEvents);
    for (const m of this.owners) m.peer.send(JSON.stringify({ type: "interview-event", event: entry } satisfies LiveServerMessage));
    this.scheduleSave();
  }

  /** Starts the clock (the candidate agreed to the rules). */
  startClock() {
    const pub = this.meta.interview?.public;
    if (!pub || pub.startedAt) return;
    pub.startedAt = Date.now();
    pub.endsAt = pub.startedAt + pub.durationMin * 60_000;
    this.log({ kind: "started", detail: `${pub.durationMin} minutes` });
    this.scheduleClock();
    this.sendPublic();
  }

  /** Ends the interview when its time is up (also after a server restart). */
  scheduleClock() {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
    const pub = this.meta.interview?.public;
    if (!pub?.endsAt || pub.endedAt) return;
    const wait = pub.endsAt - Date.now();
    if (wait <= 0) return this.endInterview("Time is up");
    // Long timers are capped by Node; check again later if needed.
    this.clockTimer = setTimeout(() => this.scheduleClock(), Math.min(wait + 50, 2 ** 30));
  }

  /** The interview is over: candidates keep watching but can no longer change the code. */
  endInterview(reason: string) {
    const pub = this.meta.interview?.public;
    if (!pub || pub.endedAt) return;
    pub.endedAt = Date.now();
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.meta.defaultRole = "viewer";
    for (const key of Object.keys(this.meta.roles)) this.meta.roles[key] = "viewer";
    for (const m of this.members.values()) {
      if (m.role === "owner") continue;
      this.meta.roles[m.clientKey] = "viewer";
      if (m.role !== "viewer") {
        m.role = "viewer";
        m.peer.send(JSON.stringify({ type: "role", role: "viewer" } satisfies LiveServerMessage));
      }
    }
    this.log({ kind: "ended", detail: reason });
    this.sendPublic();
    this.sendAll({ type: "participants", participants: this.participants() });
    this.scheduleSave();
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
      if (this.historyDirty) {
        this.historyDirty = false;
        await this.store.putHistory(this.meta.id, this.history);
      }
      // Still in use: keeps counting toward its owner's limit of open sessions.
      await this.store.addRoom(this.meta.client, this.meta.id);
    } catch (e) {
      this.onError(`could not save live session: ${String(e)}`);
    }
  }

  destroy() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.clockTimer) clearTimeout(this.clockTimer);
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
    /** Sends typed input to a running program; returns an error message or null. */
    readonly sendInput: (executionId: string, data: string, eof: boolean) => Promise<string | null> = async () => "Input is not available.",
    private readonly maxRoomsPerClient: number = LIVE_LIMITS.maxRoomsPerClient,
  ) {}

  /** Starts a session. The owner token is returned once and only its hash is kept. */
  async create(client: string, interview?: InterviewSetup | null): Promise<{ id: string; ownerToken: string }> {
    if ((await this.store.openRooms(client)) >= this.maxRoomsPerClient) {
      throw new LiveError("rate", `You can have ${this.maxRoomsPerClient} live sessions going at once. End one to start another.`);
    }
    const id = randomBytes(18).toString("base64url");
    const ownerToken = randomBytes(24).toString("base64url");
    const meta: RoomMeta = { id, ownerTokenHash: sha256(ownerToken).toString("hex"), client, createdAt: Date.now(), defaultRole: "editor", roles: {}, removed: [] };
    if (interview) {
      meta.interview = {
        public: { title: interview.title, statement: interview.statement, durationMin: interview.durationMin },
        private: { hiddenTests: interview.hiddenTests, notes: "", rating: 0, events: [] },
      };
    }
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
        if (meta.interview) {
          room.loadHistory((await this.store.getHistory(id)) ?? []);
          room.scheduleClock();
        }
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
    const iv = room.meta.interview;
    const firstCandidate = !!iv && !owner && !iv.public.candidate;
    if (firstCandidate) iv!.public.candidate = member.name;
    send({
      type: "welcome",
      you: { id: member.id, name: member.name, role: member.role, color },
      defaultRole: room.meta.defaultRole,
      participants: room.participants(),
      // In an interview the candidate does not get the interviewer's runs (they may use hidden tests).
      run: iv && !owner ? undefined : room.lastRun,
      ...(iv ? { interview: iv.public } : {}),
      ...(iv && owner ? { interviewPrivate: iv.private } : {}),
    });
    if (iv && !owner) {
      if (firstCandidate) room.sendPublic();
      room.log({ kind: "joined", who: member.name });
    }
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
    if (room.meta.interview && member.role !== "owner") room.log({ kind: "left", who: member.name });
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

  /** The session's details when `token` is its owner token (for owner-only HTTP requests), else null. */
  async verifyOwner(roomId: unknown, token: unknown): Promise<RoomMeta | null> {
    if (!isLiveRoomId(roomId) || typeof token !== 'string' || token.length === 0 || token.length > 64) return null;
    const meta = this.rooms.get(roomId)?.meta ?? (await this.store.getMeta(roomId));
    if (!meta || meta.ended) return null;
    return timingSafeEqual(sha256(token), Buffer.from(meta.ownerTokenHash, 'hex')) ? meta : null;
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
const RUN_MODES = new Set(["run", "debug", "visualize", "test"]);
const TEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REMEMBERED_RUNS = 20;

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
        if (room.meta.interview && !owner) {
          // Candidates have the compiler and Run only.
          if (msg.mode === "debug" || msg.mode === "visualize") return void room.log({ kind: "blocked", who: me.name, detail: msg.mode === "debug" ? "debugger" : "visualizer" });
          room.log({ kind: "run", who: me.name, detail: msg.mode === "test" ? "sample tests" : String(msg.entry ?? "").slice(0, 200) });
        }
        const entry = typeof msg.entry === "string" ? msg.entry.slice(0, 200) : "";
        const interactive = msg.interactive === true && msg.mode !== "test";
        const tests =
          msg.mode === "test" && Array.isArray(msg.tests)
            ? msg.tests.filter((t): t is string => typeof t === "string" && TEST_ID.test(t)).slice(0, TEST_LIMITS.maxTests)
            : undefined;
        room.lastRun = { executionId: msg.executionId, mode: msg.mode, entry, by: { id: me.id, name: me.name }, ...(interactive ? { interactive } : {}), ...(tests ? { tests } : {}) };
        room.runs.set(msg.executionId, { interactive });
        if (room.runs.size > MAX_REMEMBERED_RUNS) room.runs.delete(room.runs.keys().next().value!);
        room.broadcast(JSON.stringify({ type: "run", run: room.lastRun } satisfies LiveServerMessage), me);
        return;
      }
      case "input": {
        const run = room.runs.get(String(msg.executionId));
        const reply = (message: string) => this.send({ type: "input-error", executionId: String(msg.executionId), message });
        if (me.role === "viewer") return reply("View-only people cannot type input.");
        if (!run?.interactive) return reply("This program does not take typed input here.");
        if (typeof msg.data !== "string" || (msg.eof !== undefined && typeof msg.eof !== "boolean")) return reply("Invalid input.");
        if (utf8ByteLength(msg.data) > REQUEST_BOUNDS.maxInputChunkBytes) return reply(`Send at most ${REQUEST_BOUNDS.maxInputChunkBytes} bytes at a time.`);
        const error = await this.rooms.sendInput(String(msg.executionId), msg.data, msg.eof === true).catch(() => "The execution service is unavailable.");
        if (error) reply(error);
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
      case "interview-setup": {
        const iv = room.meta.interview;
        const setup = cleanInterviewSetup(msg.setup);
        if (!owner || !iv || !setup) return;
        iv.public.title = setup.title;
        iv.public.statement = setup.statement;
        // The duration can change until the clock starts; after that, extend it.
        if (!iv.public.startedAt) iv.public.durationMin = setup.durationMin;
        iv.private.hiddenTests = setup.hiddenTests;
        room.sendPublic();
        room.sendPrivate();
        room.scheduleSave();
        return;
      }
      case "interview-extend": {
        const pub = room.meta.interview?.public;
        const minutes = Math.round(Number(msg.minutes));
        if (!owner || !pub?.endsAt || pub.endedAt || !(minutes >= 1 && minutes <= INTERVIEW_LIMITS.maxExtendMinutes)) return;
        pub.endsAt += minutes * 60_000;
        pub.durationMin += minutes;
        room.log({ kind: "extended", detail: `+${minutes} min` });
        room.scheduleClock();
        room.sendPublic();
        return;
      }
      case "interview-end":
        if (!room.meta.interview || me.role === "viewer") return;
        room.endInterview(owner ? "Ended by the interviewer" : `${me.name} finished`);
        return;
      case "interview-notes": {
        const iv = room.meta.interview;
        if (!owner || !iv) return;
        if (typeof msg.notes === "string") iv.private.notes = msg.notes.slice(0, INTERVIEW_LIMITS.maxNotesChars);
        const rating = Math.round(Number(msg.rating));
        if (rating >= 0 && rating <= 5) iv.private.rating = rating;
        // Other tabs of the interviewer stay in step.
        for (const m of room.owners) if (m !== me) m.peer.send(JSON.stringify({ type: "interview-private", state: iv.private } satisfies LiveServerMessage));
        room.scheduleSave();
        return;
      }
      case "interview-event": {
        const iv = room.meta.interview;
        const kind = msg.event?.kind;
        if (!iv || typeof kind !== "string") return;
        const detail = typeof msg.event.detail === "string" ? msg.event.detail.slice(0, INTERVIEW_LIMITS.pastePreviewChars) : undefined;
        if (owner) {
          // The interviewer's browser reports how the candidate's runs ended.
          if (kind === "run-result") room.log({ kind, ...(detail ? { detail } : {}) });
          return;
        }
        if (!CANDIDATE_EVENTS.has(kind)) return;
        if (kind === "consent") {
          room.log({ kind, who: me.name });
          room.startClock();
          return;
        }
        const now = Date.now();
        const away = (me.awaySince ??= {});
        if (kind === "tab-hidden") away.tab = now;
        if (kind === "blur") away.window = now;
        const awayMs = kind === "tab-visible" && away.tab ? now - away.tab : kind === "focus" && away.window ? now - away.window : undefined;
        if (kind === "tab-visible") away.tab = undefined;
        if (kind === "focus") away.window = undefined;
        const chars = kind === "paste" && Number.isFinite(Number(msg.event.chars)) ? Math.max(0, Math.round(Number(msg.event.chars))) : undefined;
        room.log({ kind, who: me.name, ...(detail ? { detail } : {}), ...(chars !== undefined ? { chars } : {}), ...(awayMs !== undefined ? { awayMs } : {}) });
        return;
      }
      case "interview-history": {
        if (!owner || !room.meta.interview) return;
        const updates = room.history.map(([t, u]) => [t, Buffer.from(u).toString("base64")] as [number, string]);
        this.send({ type: "interview-history", updates });
        return;
      }
      default:
        this.send({ type: "error", code: "invalid", message: "Unknown message." });
    }
  }

  close() {
    this.rooms.leave(this.room, this.member);
  }
}
