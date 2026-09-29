import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { LiveFrame, type LiveServerMessage } from "@cw/shared";
import { LiveClose, LiveError, LiveRooms, type LiveConnection, type LiveStore, type RoomMeta } from "./rooms.js";

class MemoryStore implements LiveStore {
  meta = new Map<string, RoomMeta>();
  docs = new Map<string, Uint8Array>();
  clients = new Map<string, Set<string>>();
  async getMeta(id: string) {
    const m = this.meta.get(id);
    return m ? (structuredClone(m) as RoomMeta) : null;
  }
  async putMeta(meta: RoomMeta) {
    this.meta.set(meta.id, structuredClone(meta));
  }
  async getDoc(id: string) {
    return this.docs.get(id) ?? null;
  }
  async putDoc(id: string, state: Uint8Array) {
    this.docs.set(id, state);
  }
  async deleteDoc(id: string) {
    this.docs.delete(id);
  }
  async openRooms(client: string) {
    return this.clients.get(client)?.size ?? 0;
  }
  async addRoom(client: string, id: string) {
    this.clients.set(client, new Set([...(this.clients.get(client) ?? []), id]));
  }
  async removeRoom(client: string, id: string) {
    this.clients.get(client)?.delete(id);
  }
}

/** A participant as the browser would be: its own document and presence, speaking the wire protocol. */
class Client {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  messages: LiveServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  conn!: LiveConnection;

  constructor() {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "server" || !this.conn) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, LiveFrame.sync);
      syncProtocol.writeUpdate(enc, update);
      this.conn.binary(encoding.toUint8Array(enc));
    });
  }

  peer = {
    send: (data: Uint8Array | string) => {
      if (typeof data === "string") return void this.messages.push(JSON.parse(data) as LiveServerMessage);
      const decoder = decoding.createDecoder(data);
      const frame = decoding.readVarUint(decoder);
      if (frame === LiveFrame.sync) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, LiveFrame.sync);
        syncProtocol.readSyncMessage(decoder, reply, this.doc, "server");
        if (encoding.length(reply) > 1 && this.conn) this.conn.binary(encoding.toUint8Array(reply));
      } else {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), "server");
      }
    },
    close: (code: number, reason: string) => {
      this.closed = { code, reason };
    },
  };

  async join(rooms: LiveRooms, id: string, name: string, key: string, ownerToken?: string) {
    this.conn = await rooms.join(id, this.peer, { type: "join", room: id, name, clientKey: key, ownerToken });
    // Answer the server's state request so it gets anything we have.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, LiveFrame.sync);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.conn.binary(encoding.toUint8Array(enc));
    return this;
  }

  text(path: string) {
    return this.doc.getMap<Y.Text>("files").get(path)?.toString();
  }

  presence(state: Record<string, unknown>) {
    this.awareness.setLocalState(state);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, LiveFrame.awareness);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    this.conn.binary(encoding.toUint8Array(enc));
  }

  last<T extends LiveServerMessage["type"]>(type: T) {
    return this.messages.filter((m): m is Extract<LiveServerMessage, { type: T }> => m.type === type).at(-1);
  }
}

const KEY_A = "aaaaaaaaaaaaaaaaaaaa";
const KEY_B = "bbbbbbbbbbbbbbbbbbbb";
const KEY_C = "cccccccccccccccccccc";

async function session() {
  const store = new MemoryStore();
  const rooms = new LiveRooms(store);
  const { id, ownerToken } = await rooms.create("client-1");
  const owner = await new Client().join(rooms, id, "Teacher", KEY_A, ownerToken);
  owner.doc.transact(() => {
    const t = new Y.Text();
    t.insert(0, "class Main {}\n");
    owner.doc.getMap("files").set("Main.java", t);
    owner.doc.getMap("meta").set("ready", true);
  });
  return { store, rooms, id, ownerToken, owner };
}

describe("live rooms", () => {
  it("the owner's project reaches people who join, and their edits reach the owner", async () => {
    const { rooms, id, owner } = await session();
    expect(owner.last("welcome")?.you.role).toBe("owner");
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    expect(ravi.last("welcome")?.you.role).toBe("editor");
    expect(ravi.text("Main.java")).toBe("class Main {}\n");

    ravi.doc.getMap<Y.Text>("files").get("Main.java")!.insert(13, " // hi");
    expect(owner.text("Main.java")).toBe("class Main {} // hi\n");
    // Both typing at once merges without losing either change.
    owner.doc.getMap<Y.Text>("files").get("Main.java")!.insert(0, "public ");
    ravi.doc.getMap<Y.Text>("files").get("Main.java")!.insert(ravi.text("Main.java")!.length, "// end\n");
    expect(owner.text("Main.java")).toBe("public class Main {} // hi\n// end\n");
    expect(ravi.text("Main.java")).toBe(owner.text("Main.java"));
    expect(owner.last("participants")?.participants.map((p) => p.name)).toEqual(["Teacher", "Ravi"]);
  });

  it("view-only people receive changes but cannot make them", async () => {
    const { rooms, id, owner } = await session();
    await owner.conn.control({ type: "default-role", role: "viewer" });
    const student = await new Client().join(rooms, id, "Student", KEY_B);
    expect(student.last("welcome")?.you.role).toBe("viewer");
    student.doc.getMap<Y.Text>("files").get("Main.java")!.insert(0, "HACK ");
    expect(owner.text("Main.java")).toBe("class Main {}\n");
    owner.doc.getMap<Y.Text>("files").get("Main.java")!.insert(0, "// shared\n");
    expect(student.text("Main.java")).toContain("// shared");
  });

  it("the owner can change someone's role, and it sticks when they reconnect", async () => {
    const { rooms, id, owner } = await session();
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    const raviId = ravi.last("welcome")!.you.id;
    await owner.conn.control({ type: "set-role", id: raviId, role: "viewer" });
    expect(ravi.last("role")?.role).toBe("viewer");
    ravi.conn.close();
    const again = await new Client().join(rooms, id, "Ravi", KEY_B);
    expect(again.last("welcome")?.you.role).toBe("viewer");
    // Only the owner may change roles.
    const other = await new Client().join(rooms, id, "Other", KEY_C);
    await other.conn.control({ type: "set-role", id: again.last("welcome")!.you.id, role: "editor" });
    expect(again.last("role")).toBeUndefined();
  });

  it("removed people are disconnected and cannot come back", async () => {
    const { rooms, id, owner } = await session();
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    await owner.conn.control({ type: "remove", id: ravi.last("welcome")!.you.id });
    expect(ravi.last("removed")).toBeDefined();
    expect(ravi.closed?.code).toBe(LiveClose.removed);
    await expect(new Client().join(rooms, id, "Ravi", KEY_B)).rejects.toMatchObject({ code: "removed" });
    expect(owner.last("participants")?.participants).toHaveLength(1);
  });

  it("a wrong owner token does not make someone the owner", async () => {
    const { rooms, id } = await session();
    const fake = await new Client().join(rooms, id, "Fake", KEY_B, "not-the-token-at-all");
    expect(fake.last("welcome")?.you.role).toBe("editor");
  });

  it("nobody can move another person's cursor or pose as them", async () => {
    const { rooms, id, owner } = await session();
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    const ownerId = owner.last("welcome")!.you.id;
    const raviId = ravi.last("welcome")!.you.id;
    owner.presence({ user: { id: ownerId, name: "Teacher", color: 0 }, file: "Main.java" });
    expect(ravi.awareness.getStates().get(owner.doc.clientID)).toMatchObject({ file: "Main.java" });
    // Claiming to be the owner is ignored.
    ravi.presence({ user: { id: ownerId, name: "Teacher", color: 0 }, file: "Evil.java" });
    expect(owner.awareness.getStates().has(ravi.doc.clientID)).toBe(false);
    ravi.presence({ user: { id: raviId, name: "Ravi", color: 1 }, file: "Main.java" });
    expect(owner.awareness.getStates().get(ravi.doc.clientID)).toMatchObject({ file: "Main.java" });
    // Leaving removes the cursor for everyone.
    ravi.conn.close();
    expect(owner.awareness.getStates().has(ravi.doc.clientID)).toBe(false);
  });

  it("runs are announced to everyone else, but not by viewers", async () => {
    const { rooms, id, owner } = await session();
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    const executionId = "0b8f6f1e-5d3c-4c9a-9f5e-1a2b3c4d5e6f";
    await owner.conn.control({ type: "run", executionId, mode: "run", entry: "Main.java" });
    expect(ravi.last("run")?.run).toMatchObject({ executionId, mode: "run", by: { name: "Teacher" } });
    expect(owner.last("run")).toBeUndefined();
    // Someone joining later sees the latest run.
    const late = await new Client().join(rooms, id, "Late", KEY_C);
    expect(late.last("welcome")?.run?.executionId).toBe(executionId);

    await owner.conn.control({ type: "default-role", role: "viewer" });
    const viewer = await new Client().join(rooms, id, "Viewer", "dddddddddddddddddddd");
    await viewer.conn.control({ type: "run", executionId: "1b8f6f1e-5d3c-4c9a-9f5e-1a2b3c4d5e6f", mode: "run", entry: "Main.java" });
    expect(ravi.last("run")?.run.executionId).toBe(executionId);
  });

  it("sessions survive a server restart", async () => {
    const { store, rooms, id, ownerToken } = await session();
    await rooms.saveAll();
    const restarted = new LiveRooms(store);
    const owner = await new Client().join(restarted, id, "Teacher", KEY_A, ownerToken);
    expect(owner.last("welcome")?.you.role).toBe("owner");
    expect(owner.text("Main.java")).toBe("class Main {}\n");
  });

  it("ending the session disconnects everyone and the link stops working", async () => {
    const { rooms, id, owner } = await session();
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    await ravi.conn.control({ type: "end" });
    expect(ravi.closed).toBeNull();
    await owner.conn.control({ type: "end" });
    expect(ravi.last("ended")).toBeDefined();
    expect(ravi.closed?.code).toBe(LiveClose.ended);
    await expect(new Client().join(rooms, id, "Ravi", KEY_B)).rejects.toBeInstanceOf(LiveError);
  });

  it("rejects bad links and limits how many sessions one person opens", async () => {
    const store = new MemoryStore();
    const rooms = new LiveRooms(store);
    await expect(new Client().join(rooms, "short", "X", KEY_A)).rejects.toMatchObject({ code: "not-found" });
    await expect(new Client().join(rooms, "A".repeat(24), "X", KEY_A)).rejects.toMatchObject({ code: "not-found" });
    for (let i = 0; i < 10; i++) await rooms.create("busy");
    await expect(rooms.create("busy")).rejects.toMatchObject({ code: "rate" });
  });

  it("people who can edit may type input into an announced interactive run; viewers may not", async () => {
    const store = new MemoryStore();
    const sent: [string, string, boolean][] = [];
    const rooms = new LiveRooms(store, () => {}, async (id, data, eof) => {
      sent.push([id, data, eof]);
      return null;
    });
    const { id, ownerToken } = await rooms.create("c");
    const owner = await new Client().join(rooms, id, "Teacher", KEY_A, ownerToken);
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    const executionId = "0b8f6f1e-5d3c-4c9a-9f5e-1a2b3c4d5e6f";

    // Not announced yet: refused.
    await ravi.conn.control({ type: "input", executionId, data: "5\n" });
    expect(ravi.last("input-error")?.message).toMatch(/does not take typed input/);
    await owner.conn.control({ type: "run", executionId, mode: "run", entry: "Main.java", interactive: true });
    expect(ravi.last("run")?.run.interactive).toBe(true);
    await ravi.conn.control({ type: "input", executionId, data: "5\n" });
    await ravi.conn.control({ type: "input", executionId, data: "", eof: true });
    expect(sent).toEqual([
      [executionId, "5\n", false],
      [executionId, "", true],
    ]);

    await owner.conn.control({ type: "set-role", id: ravi.last("welcome")!.you.id, role: "viewer" });
    await ravi.conn.control({ type: "input", executionId, data: "6\n" });
    expect(sent).toHaveLength(2);
    expect(ravi.last("input-error")?.message).toMatch(/View-only/);
  });

  it("test runs are announced with the tests they ran", async () => {
    const { rooms, id, owner } = await session();
    const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
    await owner.conn.control({ type: "run", executionId: "0b8f6f1e-5d3c-4c9a-9f5e-1a2b3c4d5e6f", mode: "test", entry: "Main.java", tests: ["t1", "t2", "bad id!"] });
    expect(ravi.last("run")?.run).toMatchObject({ mode: "test", tests: ["t1", "t2"] });
    expect(ravi.last("run")?.run.interactive).toBeUndefined();
  });
});
