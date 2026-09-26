import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Drives the Java debug adapter against a real JVM on the host. Skipped when
 * no JDK is installed; the Docker path is covered by the debugger E2E tests.
 */
const hasJdk = spawnSync("javac", ["-version"]).status === 0;
const ADAPTER_SOURCE = fileURLToPath(new URL("../../debug-adapters/java/CwDebugAdapter.java", import.meta.url));

const PROGRAM = `public class Main {
    static int square(int x) {
        int r = x * x;
        return r;
    }
    public static void main(String[] args) {
        int[] nums = {3, 1, 2};
        int total = 0;
        for (int n : nums) {
            total += square(n);
        }
        System.out.println("total=" + total);
    }
    static int calls = 0;
    static final String NAME = "demo";
}
`;

type Msg = Record<string, unknown> & { type: string; event?: string; requestSeq?: number };

describe.skipIf(!hasJdk)("Java debug adapter (host JDK)", () => {
  let dir: string;
  let proc: ChildProcessWithoutNullStreams;
  const messages: Msg[] = [];
  const waiters: { pred: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];
  let seq = 0;

  const waitFor = (pred: (m: Msg) => boolean) =>
    new Promise<Msg>((resolve) => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
    });
  const nextStop = () => {
    const before = messages.length;
    return waitFor((m) => m.event === "stopped" && messages.indexOf(m) >= before);
  };
  const request = async (cmd: string, extra: Record<string, unknown> = {}) => {
    const s = ++seq;
    proc.stdin.write(JSON.stringify({ seq: s, cmd, ...extra }) + "\n");
    return waitFor((m) => m.type === "response" && m.requestSeq === s);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cw-adapter-"));
    writeFileSync(join(dir, "Main.java"), PROGRAM);
    expect(spawnSync("javac", ["-d", join(dir, "adapter"), ADAPTER_SOURCE]).status).toBe(0);
    expect(spawnSync("javac", ["-g", "-d", join(dir, "out"), join(dir, "Main.java")]).status).toBe(0);
    proc = spawn("java", ["-cp", join(dir, "adapter"), "CwDebugAdapter"]);
    createInterface({ input: proc.stdout }).on("line", (line) => {
      const m = JSON.parse(line) as Msg;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill();
      await exited;
    }
    // Temp cleanup is best effort: Windows may hold handles briefly after the JVMs exit.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  });

  it("stops at breakpoints, reads variables, evaluates watches, steps and exits", async () => {
    const stop = nextStop();
    const launch = await request("launch", { mainClass: "Main", classpath: join(dir, "out"), files: ["Main.java"], breakpoints: { "Main.java": [10] } });
    expect(launch.success).toBe(true);
    let e = await stop;
    let frames = e.frames as { name: string; line: number; localsRef: number }[];
    expect(e.reason).toBe("breakpoint");
    expect(frames[0]).toMatchObject({ name: "Main.main", line: 10 });

    const vars = (await request("variables", { ref: frames[0]!.localsRef })).variables as { name: string; value: string; ref: number }[];
    expect(vars.map((v) => `${v.name}=${v.value}`)).toEqual(expect.arrayContaining(["total=0", "n=3", "nums=int[3]"]));
    const statics = vars.find((v) => v.name === "static")!;
    expect(statics.value).toBe("Main (2 fields)");
    const fields = (await request("variables", { ref: statics.ref })).variables as { name: string; value: string }[];
    expect(fields.map((v) => `${v.name}=${v.value}`)).toEqual(["calls=0", 'NAME="demo"']);
    const nums = (await request("variables", { ref: vars.find((v) => v.name === "nums")!.ref })).variables as { value: string }[];
    expect(nums.map((v) => v.value)).toEqual(["3", "1", "2"]);

    const watch = async (expression: string) => (await request("evaluate", { expression, frame: 0 })) as { result?: { value: string }; error?: string };
    expect((await watch("n * 10 + total")).result?.value).toBe("30");
    expect((await watch("nums[2] == 2 && !false")).result?.value).toBe("true");
    expect((await watch("nums[7]")).error).toMatch(/out of bounds/);
    expect((await watch("Math.max(1, 2)")).error).toBeTruthy();

    let s = nextStop();
    await request("stepIn");
    e = await s;
    frames = e.frames as typeof frames;
    expect(frames.map((f) => f.name)).toEqual(["Main.square", "Main.main"]);

    s = nextStop();
    await request("stepOut");
    e = await s;
    expect((e.frames as typeof frames)[0]!.name).toBe("Main.main");

    await request("setBreakpoints", { file: "Main.java", lines: [] });
    const exited = waitFor((m) => m.event === "exited");
    await request("continue");
    expect((await exited).exitCode).toBe(0);
    const output = messages.filter((m) => m.event === "output").map((m) => m.text).join("");
    expect(output).toContain("total=14");
  }, 60_000);
});
