import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { LiveFrame, cleanInterviewSetup, type ExecutionRequest, type InterviewSetup, type LiveServerMessage } from "@cw/shared";
import { LiveClose, LiveError, LiveRooms, type JudgeRun, type LiveConnection, type LiveStore, type RoomMeta } from "./rooms.js";

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
  history = new Map<string, [number, Uint8Array][]>();
  async getHistory(id: string) {
    return this.history.get(id) ?? null;
  }
  async putHistory(id: string, h: [number, Uint8Array][]) {
    this.history.set(id, [...h]);
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

  it("a session whose owner has been gone for ten minutes closes by itself; coming back in time keeps it", async () => {
    vi.useFakeTimers();
    try {
      const { rooms, store, id, ownerToken, owner } = await session();
      const ravi = await new Client().join(rooms, id, "Ravi", KEY_B);
      owner.conn.close();
      vi.advanceTimersByTime(9 * 60_000);
      expect(ravi.closed).toBeNull();
      // Back in time: the count starts again the next time they leave.
      const back = await new Client().join(rooms, id, "Teacher", KEY_A, ownerToken);
      vi.advanceTimersByTime(5 * 60_000);
      expect(ravi.closed).toBeNull();
      back.conn.close();
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 100);
      expect(ravi.last("ended")).toBeDefined();
      expect(ravi.closed?.code).toBe(LiveClose.ended);
      expect((await store.getMeta(id))?.ended).toBe(true);
      await expect(new Client().join(rooms, id, "Late", KEY_C)).rejects.toMatchObject({ code: "not-found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("with nobody left connected, the link stops working once the owner has been gone ten minutes", async () => {
    vi.useFakeTimers();
    try {
      const { rooms, store, id, owner } = await session();
      owner.conn.close();
      await rooms.saveAll();
      // A restarted server knows when the owner left.
      vi.advanceTimersByTime(11 * 60_000);
      await expect(new Client().join(new LiveRooms(store), id, "Ravi", KEY_B)).rejects.toMatchObject({ code: "not-found" });
      expect(store.docs.has(id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  describe("interview mode", () => {
    const SETUP = {
      title: "Two sum",
      statement: "Read n numbers and a target...",
      durationMin: 30,
      hiddenTests: [{ id: "h1", input: "4\n1 2 3 4\n7", expected: "2 3" }],
    };

    async function interview(setup: InterviewSetup = SETUP, judgeRun?: JudgeRun) {
      const store = new MemoryStore();
      const rooms = new LiveRooms(store, undefined, undefined, undefined, judgeRun);
      const { id, ownerToken } = await rooms.create("c", cleanInterviewSetup(setup)!);
      const hr = await new Client().join(rooms, id, "Interviewer", KEY_A, ownerToken);
      hr.doc.transact(() => {
        const t = new Y.Text();
        t.insert(0, "class Main {}\n");
        hr.doc.getMap("files").set("Main.java", t);
        hr.doc.getMap("meta").set("ready", true);
      });
      const cand = await new Client().join(rooms, id, "Asha", KEY_B);
      return { store, rooms, id, ownerToken, hr, cand };
    }

    it("the candidate sees the problem but never the hidden tests, notes or activity", async () => {
      const { hr, cand } = await interview();
      expect(cand.last("welcome")?.interview).toMatchObject({ title: "Two sum", durationMin: 30, candidate: "Asha" });
      expect(cand.last("welcome")?.interviewPrivate).toBeUndefined();
      expect(JSON.stringify(cand.messages)).not.toContain("1 2 3 4");
      expect(hr.last("welcome")?.interviewPrivate?.hiddenTests).toHaveLength(1);
      expect(hr.last("interview-event")?.event).toMatchObject({ kind: "joined", who: "Asha" });
    });

    it("the clock starts when the candidate agrees, and at the end the code locks", async () => {
      const { hr, cand } = await interview();
      expect(cand.last("welcome")?.interview?.startedAt).toBeUndefined();
      await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
      const state = cand.last("interview")!.state;
      expect(state.endsAt! - state.startedAt!).toBe(30 * 60_000);
      await hr.conn.control({ type: "interview-extend", minutes: 5 });
      expect(cand.last("interview")!.state.endsAt! - state.startedAt!).toBe(35 * 60_000);

      await cand.conn.control({ type: "interview-end" });
      expect(cand.last("role")?.role).toBe("viewer");
      expect(cand.last("interview")?.state.endedAt).toBeDefined();
      cand.doc.getMap<Y.Text>("files").get("Main.java")!.insert(0, "late ");
      expect(hr.text("Main.java")).toBe("class Main {}\n");
      expect(hr.last("interview-event")?.event).toMatchObject({ kind: "ended", detail: "Asha finished" });
    });

    it("time running out locks the candidate by itself", async () => {
      vi.useFakeTimers();
      try {
        const { cand } = await interview();
        await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
        vi.advanceTimersByTime(30 * 60_000 + 100);
        expect(cand.last("role")?.role).toBe("viewer");
        expect(cand.last("interview")?.state.endedAt).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("tab switches, pastes and blocked tools are reported to the interviewer only", async () => {
      const { hr, cand } = await interview();
      await cand.conn.control({ type: "interview-event", event: { kind: "tab-hidden" } });
      await cand.conn.control({ type: "interview-event", event: { kind: "tab-visible" } });
      expect(hr.last("interview-event")?.event).toMatchObject({ kind: "tab-visible", who: "Asha" });
      expect(hr.last("interview-event")?.event.awayMs).toBeGreaterThanOrEqual(0);
      await cand.conn.control({ type: "interview-event", event: { kind: "paste", chars: 250, detail: "for (int i..." } });
      expect(hr.last("interview-event")?.event).toMatchObject({ kind: "paste", chars: 250 });
      await cand.conn.control({ type: "run", executionId: "0b8f6f1e-5d3c-4c9a-9f5e-1a2b3c4d5e6f", mode: "debug", entry: "Main.java" });
      expect(hr.last("interview-event")?.event).toMatchObject({ kind: "blocked", detail: "debugger" });
      expect(hr.last("run")).toBeUndefined();
      // A candidate cannot write in the log as someone else, or use interviewer-only kinds.
      await cand.conn.control({ type: "interview-event", event: { kind: "run-result", detail: "SUCCESS" } });
      expect(hr.last("interview-event")?.event.kind).toBe("blocked");
      expect(cand.messages.some((m) => m.type === "interview-event")).toBe(false);
    });

    /** A sandbox that doubles each test's number, or prints `wrong` for inputs listed in `bad`. */
    const doubling =
      (bad: string[] = [], seen: ExecutionRequest[] = []): JudgeRun =>
      async (request) => {
        seen.push(request);
        return {
          id: "x",
          status: "SUCCESS",
          language: request.language,
          stdout: "",
          stderr: "",
          compileOutput: "",
          runtimeVersion: "",
          createdAt: "",
          tests: request.tests!.map((input, index) => ({ index, status: "SUCCESS" as const, stdout: bad.includes(input) ? "wrong\n" : `${Number(input) * 2}\n`, stderr: "", executionTime: 5 })),
        };
      };
    const JUDGED: InterviewSetup = {
      title: "Double it",
      statement: "Print 2n.",
      durationMin: 30,
      samples: [{ id: "s1", input: "2", expected: "4" }],
      hiddenTests: [
        { id: "h1", input: "5", expected: "10" },
        { id: "h2", input: "3000", expected: "6000  \n\n" },
      ],
    };

    it("Submit checks the code on every test; the candidate gets the score, the interviewer every output", async () => {
      const seen: ExecutionRequest[] = [];
      const { hr, cand } = await interview(JUDGED, doubling([], seen));
      // Nothing is checked before the interview starts.
      await cand.conn.control({ type: "interview-submit" });
      expect(seen).toHaveLength(0);
      await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
      await cand.conn.control({ type: "interview-submit" });
      expect(seen[0]).toMatchObject({ mode: "test", tests: ["2", "5", "3000"], files: [{ path: "Main.java", content: "class Main {}\n" }] });
      const state = cand.last("interview")!.state;
      expect(state.judging).toBe(false);
      expect(state.verdicts).toEqual([expect.objectContaining({ status: "accepted", passed: 3, total: 3, timeMs: 5 })]);
      // The candidate never receives a hidden test's input or expected output.
      expect(JSON.stringify(cand.messages)).not.toContain("3000");
      expect(hr.last("interview-private")?.state.submission).toMatchObject({ by: "Asha", tests: [{ id: "s1", kind: "sample", verdict: "passed" }, { id: "h1", kind: "hidden", verdict: "passed", stdout: "10\n" }, { id: "h2", verdict: "passed" }] });
      expect(hr.last("interview-event")?.event).toMatchObject({ kind: "submit", who: "Asha", detail: "Accepted: 3 / 3 tests passed" });
      // The interviewer's own Submit does nothing: only candidates hand in.
      await hr.conn.control({ type: "interview-submit" });
      expect(seen).toHaveLength(1);
    });

    it("a wrong answer names the first failing test, and what is handed in at the end is checked too", async () => {
      const seen: ExecutionRequest[] = [];
      const { hr, cand } = await interview(JUDGED, doubling(["5"], seen));
      await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
      await cand.conn.control({ type: "interview-submit" });
      expect(cand.last("interview")!.state.verdicts!.at(-1)).toMatchObject({ status: "wrong-answer", passed: 2, total: 3, firstFailed: { kind: "hidden", number: 1 } });
      // The same code is not checked again at the end; changed code is.
      cand.doc.getMap<Y.Text>("files").get("Main.java")!.insert(0, "// fixed\n");
      await cand.conn.control({ type: "interview-end" });
      await vi.waitFor(() => expect(hr.last("interview-private")?.state.submission?.verdict.final).toBe(true));
      expect(seen).toHaveLength(2);
      expect(seen[1]!.files[0]!.content).toContain("// fixed");
      expect(cand.last("interview")!.state.verdicts).toHaveLength(2);
    });

    it("code that does not compile, and a sandbox that is down, are told apart", async () => {
      let mode: "compile" | "down" = "compile";
      const { cand } = await interview(JUDGED, async (request) => {
        if (mode === "down") throw new Error("The execution service is not available.");
        return { id: "x", status: "COMPILATION_ERROR", language: request.language, stdout: "", stderr: "", compileOutput: "Main.java:1: error: ';' expected", runtimeVersion: "", createdAt: "" };
      });
      await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
      await cand.conn.control({ type: "interview-submit" });
      expect(cand.last("interview")!.state.verdicts!.at(-1)).toMatchObject({ status: "compile-error", passed: 0, total: 3, compileOutput: "Main.java:1: error: ';' expected" });
      mode = "down";
      vi.useFakeTimers();
      try {
        vi.advanceTimersByTime(4000);
        await cand.conn.control({ type: "interview-submit" });
      } finally {
        vi.useRealTimers();
      }
      expect(cand.last("interview")!.state.verdicts!.at(-1)).toMatchObject({ status: "error", message: "The execution service is not available. Submit again in a moment." });
    });

    it("leaving the window is counted, and at the limit the interview ends", async () => {
      vi.useFakeTimers();
      try {
        const { hr, cand } = await interview({ ...JUDGED, maxLeaves: 2 });
        // Before the clock starts nothing counts.
        await cand.conn.control({ type: "interview-event", event: { kind: "blur" } });
        await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
        expect(cand.last("interview")!.state).toMatchObject({ maxLeaves: 2, leaves: 0 });
        vi.advanceTimersByTime(5000);
        // Alt+Tab out of full screen reports both: one time.
        await cand.conn.control({ type: "interview-event", event: { kind: "blur" } });
        await cand.conn.control({ type: "interview-event", event: { kind: "fullscreen-exit" } });
        expect(cand.last("interview")!.state).toMatchObject({ leaves: 1 });
        expect(cand.last("interview")!.state.endedAt).toBeUndefined();
        vi.advanceTimersByTime(5000);
        await cand.conn.control({ type: "interview-event", event: { kind: "tab-hidden" } });
        expect(cand.last("interview")!.state).toMatchObject({ leaves: 2 });
        expect(cand.last("interview")!.state.endedAt).toBeDefined();
        expect(cand.last("role")?.role).toBe("viewer");
        expect(hr.last("interview-event")?.event).toMatchObject({ kind: "ended", detail: "Asha left the interview window 2 times" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("an interview whose interviewer has been gone for ten minutes ends, and is kept for the report", async () => {
      vi.useFakeTimers();
      try {
        const { rooms, id, ownerToken, hr, cand } = await interview();
        await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
        hr.conn.close();
        vi.advanceTimersByTime(10 * 60_000 + 100);
        expect(cand.last("interview")!.state).toMatchObject({ endReason: "The interviewer was away for 10 minutes" });
        expect(cand.last("role")?.role).toBe("viewer");
        expect(cand.closed).toBeNull();
        const back = await new Client().join(rooms, id, "Interviewer", KEY_A, ownerToken);
        expect(back.last("welcome")?.interview?.endedAt).toBeDefined();
        expect(back.text("Main.java")).toBe("class Main {}\n");
      } finally {
        vi.useRealTimers();
      }
    });

    it("when the interview ends, the session closes for the candidate and stays for the interviewer", async () => {
      vi.useFakeTimers();
      try {
        const { rooms, id, hr, cand } = await interview(JUDGED, doubling());
        await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
        await hr.conn.control({ type: "interview-end" });
        // Long enough to see how the code that was handed in did.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(cand.closed).toBeNull();
        expect(cand.last("interview")!.state.verdicts!.at(-1)).toMatchObject({ final: true, status: "accepted" });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(cand.last("ended")).toBeDefined();
        expect(cand.closed?.code).toBe(LiveClose.ended);
        expect(hr.closed).toBeNull();
        expect(hr.last("participants")!.participants).toHaveLength(1);
        await expect(new Client().join(rooms, id, "Asha", KEY_B)).rejects.toMatchObject({ code: "not-found", message: "This interview has ended." });
      } finally {
        vi.useRealTimers();
      }
    });

    it("camera set-up messages pass between the interviewer and the candidate only", async () => {
      const { rooms, id, hr, cand } = await interview();
      const other = await new Client().join(rooms, id, "Ravi", KEY_C);
      const ids = (c: Client) => c.last("welcome")!.you.id;
      await hr.conn.control({ type: "rtc", to: ids(cand), data: { kind: "want" } });
      expect(cand.last("rtc")).toEqual({ type: "rtc", from: ids(hr), data: { kind: "want" } });
      await cand.conn.control({ type: "rtc", to: ids(hr), data: { kind: "offer", call: "c1", sdp: "v=0" } });
      expect(hr.last("rtc")).toMatchObject({ from: ids(cand), data: { kind: "offer", call: "c1", sdp: "v=0" } });
      // One candidate cannot reach another, and oversized or unknown messages are dropped.
      await cand.conn.control({ type: "rtc", to: ids(other), data: { kind: "offer", call: "c1", sdp: "v=0" } });
      expect(other.last("rtc")).toBeUndefined();
      await cand.conn.control({ type: "rtc", to: ids(hr), data: { kind: "offer", call: "c1", sdp: "x".repeat(40_000) } });
      await cand.conn.control({ type: "rtc", to: ids(hr), data: { kind: "anything" } as never });
      expect(hr.messages.filter((m) => m.type === "rtc")).toHaveLength(1);
    });

    it("with no limit, leaving is only recorded", async () => {
      const { cand } = await interview({ ...JUDGED, maxLeaves: 0 });
      await cand.conn.control({ type: "interview-event", event: { kind: "consent" } });
      await cand.conn.control({ type: "interview-event", event: { kind: "tab-hidden" } });
      expect(cand.last("interview")!.state).toMatchObject({ leaves: 1 });
      expect(cand.last("interview")!.state.endedAt).toBeUndefined();
    });

    it("notes, rating and hidden tests are the interviewer's; the typing history can be replayed", async () => {
      const { hr, cand, rooms, store, id, ownerToken } = await interview();
      await cand.conn.control({ type: "interview-notes", notes: "hacked", rating: 5 });
      await hr.conn.control({ type: "interview-notes", notes: "Clear thinking", rating: 4 });
      cand.doc.getMap<Y.Text>("files").get("Main.java")!.insert(0, "// hello\n");
      await hr.conn.control({ type: "interview-history" });
      const updates = hr.last("interview-history")!.updates;
      expect(updates.length).toBeGreaterThanOrEqual(2);
      const replay = new Y.Doc();
      for (const [, u] of updates) Y.applyUpdate(replay, Buffer.from(u, "base64"));
      expect(replay.getMap<Y.Text>("files").get("Main.java")!.toString()).toBe("// hello\nclass Main {}\n");
      // Survives a restart.
      await rooms.saveAll();
      const again = await new Client().join(new LiveRooms(store), id, "Interviewer", KEY_A, ownerToken);
      expect(again.last("welcome")?.interviewPrivate).toMatchObject({ notes: "Clear thinking", rating: 4 });
      await again.conn.control({ type: "interview-history" });
      expect(again.last("interview-history")!.updates.length).toBe(updates.length);
    });
  });
});
