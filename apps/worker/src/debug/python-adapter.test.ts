import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Drives the Python debug adapter with a host interpreter. Skipped when no
 * Python 3.11+ is installed; the Docker path is covered by the E2E tests.
 */
const PYTHON = ["python3", "python"].find((cmd) => {
  const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "True";
});
const ADAPTER = fileURLToPath(new URL("../../debug-adapters/python/cw_debug_adapter.py", import.meta.url));

const PROGRAM = `class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y


def square(x):
    r = x * x
    return r


def main():
    nums = [3, 1, 2]
    p = Point(1, 2)
    total = 0
    for n in nums:
        total += square(n)
    print("total=" + str(total))


main()
`;

type Msg = Record<string, unknown> & { type: string; event?: string; requestSeq?: number };
type Frame = { name: string; line: number; file: string | null; localsRef: number };
type Var = { name: string; value: string; type: string; ref: number };

class Session {
  readonly dir = mkdtempSync(join(tmpdir(), "cw-pyadapter-"));
  readonly messages: Msg[] = [];
  private waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  private seq = 0;
  private proc: ChildProcessWithoutNullStreams;

  constructor(files: Record<string, string>, stdin = "") {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(this.dir, name), content);
    writeFileSync(join(this.dir, "stdin.txt"), stdin);
    this.proc = spawn(PYTHON!, [ADAPTER], { cwd: this.dir });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const m = JSON.parse(line) as Msg;
      this.messages.push(m);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
  }

  waitFor(pred: (m: Msg) => boolean) {
    return new Promise<Msg>((resolve) => {
      const hit = this.messages.find(pred);
      if (hit) return resolve(hit);
      this.waiters.push({ pred, resolve });
    });
  }

  nextStop() {
    const before = this.messages.length;
    return this.waitFor((m) => m.event === "stopped" && this.messages.indexOf(m) >= before);
  }

  request(cmd: string, extra: Record<string, unknown> = {}) {
    const s = ++this.seq;
    this.proc.stdin.write(JSON.stringify({ seq: s, cmd, ...extra }) + "\n");
    return this.waitFor((m) => m.type === "response" && m.requestSeq === s);
  }

  launch(files: string[], breakpoints: Record<string, number[]> = {}) {
    return this.request("launch", { entry: "main.py", root: this.dir, stdinPath: join(this.dir, "stdin.txt"), files, breakpoints });
  }

  async vars(ref: number) {
    return (await this.request("variables", { ref })).variables as Var[];
  }

  async watch(expression: string, frame = 0) {
    return (await this.request("evaluate", { expression, frame })) as { result?: { value: string }; error?: string };
  }

  output(stream?: string) {
    return this.messages
      .filter((m) => m.event === "output" && (!stream || m.stream === stream))
      .map((m) => m.text)
      .join("");
  }

  async close() {
    if (this.proc.exitCode === null) {
      const exited = new Promise((r) => this.proc.once("exit", r));
      this.proc.kill();
      await exited;
    }
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}

describe.skipIf(!PYTHON)("Python debug adapter (host Python)", () => {
  let session: Session | undefined;
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it("stops at breakpoints, reads variables, evaluates watches, steps and exits", async () => {
    const s = (session = new Session({ "main.py": PROGRAM }));
    const stop = s.nextStop();
    expect((await s.launch(["main.py"], { "main.py": [17, 5] })).success).toBe(true);
    const verified = await s.waitFor((m) => m.event === "breakpoints");
    expect(verified.breakpoints).toEqual([
      { line: 5, verified: false },
      { line: 17, verified: true },
    ]);

    let e = await stop;
    let frames = e.frames as Frame[];
    expect(e.reason).toBe("breakpoint");
    expect(frames.map((f) => `${f.name}:${f.line}`)).toEqual(["main:17", "<module>:21"]);
    expect(frames[0]!.file).toBe("main.py");

    const locals = await s.vars(frames[0]!.localsRef);
    expect(locals.map((v) => `${v.name}=${v.value}`)).toEqual(["nums=[3, 1, 2]", "p=Point(x=1, y=2)", "total=0", "n=3"]);
    const nums = await s.vars(locals.find((v) => v.name === "nums")!.ref);
    expect(nums.map((v) => `${v.name}=${v.value}`)).toEqual(["[0]=3", "[1]=1", "[2]=2"]);
    const point = await s.vars(locals.find((v) => v.name === "p")!.ref);
    expect(point.map((v) => `${v.name}=${v.value}`)).toEqual(["x=1", "y=2"]);
    const globals = await s.vars(frames[1]!.localsRef);
    expect(globals.map((v) => v.name)).toEqual(["Point", "square", "main"]);

    expect((await s.watch("n * 10 + total")).result?.value).toBe("30");
    expect((await s.watch("nums[2] == 2 and not False")).result?.value).toBe("True");
    expect((await s.watch("p.x + p.y")).result?.value).toBe("3");
    expect((await s.watch("len(nums) + max(nums)")).result?.value).toBe("6");
    expect((await s.watch("nums[1:]")).result?.value).toBe("[1, 2]");
    expect((await s.watch("nums[7]")).error).toMatch(/out of range/);
    expect((await s.watch("square(2)")).error).toMatch(/built-in functions/);
    expect((await s.watch("10 ** 10 ** 10")).error).toMatch(/too large/);
    expect((await s.watch("missing")).error).toMatch(/not defined/);

    let next = s.nextStop();
    await s.request("stepIn");
    e = await next;
    frames = e.frames as Frame[];
    expect(frames.map((f) => `${f.name}:${f.line}`)).toEqual(["square:8", "main:17", "<module>:21"]);

    next = s.nextStop();
    await s.request("stepOver");
    expect(((await next).frames as Frame[])[0]).toMatchObject({ name: "square", line: 9 });

    next = s.nextStop();
    await s.request("stepOut");
    e = await next;
    expect((e.frames as Frame[])[0]!.name).toBe("main");

    await s.request("setBreakpoints", { file: "main.py", lines: [] });
    const exited = s.waitFor((m) => m.event === "exited");
    await s.request("continue");
    expect((await exited).exitCode).toBe(0);
    expect(s.output("stdout")).toBe("total=14\n");
  }, 30_000);

  it("stops on an uncaught exception and reports it like a normal run", async () => {
    const s = (session = new Session({ "main.py": "x = int(input())\nprint(10 // x)\n" }, "0\n"));
    const stop = s.nextStop();
    await s.launch(["main.py"]);
    const e = await stop;
    expect(e.reason).toBe("exception");
    expect(e.description).toBe("ZeroDivisionError: integer division or modulo by zero");
    const frames = e.frames as Frame[];
    expect(frames[0]).toMatchObject({ name: "<module>", line: 2 });
    expect((await s.vars(frames[0]!.localsRef)).map((v) => `${v.name}=${v.value}`)).toEqual(["x=0"]);

    const exited = s.waitFor((m) => m.event === "exited");
    await s.request("continue");
    expect((await exited).exitCode).toBe(1);
    const stderr = s.output("stderr");
    expect(stderr).toMatch(/^Traceback \(most recent call last\):/);
    expect(stderr).toContain("ZeroDivisionError");
    expect(stderr).not.toContain("runpy");
    expect(stderr).not.toContain("cw_debug_adapter");
  }, 30_000);

  it("pauses a busy loop and sets breakpoints while running", async () => {
    const s = (session = new Session({ "main.py": "i = 0\nwhile True:\n    i += 1\n    if i < 0:\n        break\n" }));
    await s.launch(["main.py"]);
    await s.waitFor((m) => m.event === "continued");
    await new Promise((r) => setTimeout(r, 200));

    let next = s.nextStop();
    await s.request("pause");
    let e = await next;
    expect(e.reason).toBe("pause");
    const i = Number((await s.watch("i")).result?.value);
    expect(i).toBeGreaterThan(0);

    // Resume, then add a breakpoint while the program is running.
    await s.request("continue");
    await new Promise((r) => setTimeout(r, 100));
    next = s.nextStop();
    const set = await s.request("setBreakpoints", { file: "main.py", lines: [4] });
    expect(set.breakpoints).toEqual([{ line: 4, verified: true }]);
    e = await next;
    expect(e.reason).toBe("breakpoint");
    expect(Number((await s.watch("i")).result?.value)).toBeGreaterThan(i);
  }, 30_000);

  it("gives the program its own stdin and keeps output separate from the protocol", async () => {
    const s = (session = new Session({ "main.py": "import sys\nname = input()\nprint('hi', name)\nprint('{\"type\": \"event\"}')\nsys.exit(3)\n" }, "Ada\n"));
    const exited = s.waitFor((m) => m.event === "exited");
    await s.launch(["main.py"]);
    expect((await exited).exitCode).toBe(3);
    expect(s.output("stdout")).toBe('hi Ada\n{"type": "event"}\n');
  }, 30_000);
});
