import { describe, expect, it } from "vitest";
import { classifyCompile, classifyRun, type StepOutcome } from "./classify.js";
import { WRITE_SCRIPT, buildWriteBatches } from "./files.js";

const ok: StepOutcome = { exitCode: 0, timedOut: false, outputLimited: false, cancelled: false, oomKilled: false };

describe("classifyRun", () => {
  it.each<[Partial<StepOutcome>, string]>([
    [{}, "SUCCESS"],
    [{ exitCode: 1 }, "RUNTIME_ERROR"],
    [{ exitCode: 137 }, "MEMORY_LIMIT"],
    [{ exitCode: 137, oomKilled: true }, "MEMORY_LIMIT"],
    [{ exitCode: 137, timedOut: true }, "TIME_LIMIT"],
    [{ exitCode: 137, outputLimited: true }, "OUTPUT_LIMIT"],
    [{ exitCode: 137, cancelled: true, timedOut: true }, "CANCELLED"],
    [{ exitCode: null }, "SYSTEM_ERROR"],
  ])("%o → %s", (patch, status) => {
    expect(classifyRun({ ...ok, ...patch })).toBe(status);
  });
});

describe("classifyCompile", () => {
  it("returns null on success and errors otherwise", () => {
    expect(classifyCompile(ok)).toBeNull();
    expect(classifyCompile({ ...ok, exitCode: 1 })?.status).toBe("COMPILATION_ERROR");
    expect(classifyCompile({ ...ok, timedOut: true, exitCode: 137 })?.message).toMatch(/too long/);
  });
});

/** Replays what WRITE_SCRIPT does with its positional args, in JS. */
function decode(argv: string[]): Map<string, string> {
  expect(argv.slice(0, 4)).toEqual(["sh", "-c", WRITE_SCRIPT, "sh"]);
  const files = new Map<string, Buffer>();
  const args = argv.slice(4);
  expect(args.length % 3).toBe(0);
  for (let i = 0; i < args.length; i += 3) {
    const [mode, path, data] = [args[i]!, args[i + 1]!, args[i + 2]!];
    const bytes = Buffer.from(data, "base64");
    files.set(path, mode === "w" ? bytes : Buffer.concat([files.get(path) ?? Buffer.alloc(0), bytes]));
  }
  return new Map([...files].map(([k, v]) => [k, v.toString("utf8")]));
}

describe("buildWriteBatches", () => {
  it("round-trips small files including unicode and empty files", () => {
    const files = [
      { path: "Main.java", content: 'class Main { String s = "héllo 🌍"; }' },
      { path: "src/empty.txt", content: "" },
    ];
    const batches = buildWriteBatches(files);
    expect(batches).toHaveLength(1);
    const out = decode(batches[0]!.argv);
    expect(out.get("Main.java")).toBe(files[0]!.content);
    expect(out.get("src/empty.txt")).toBe("");
  });

  it("chunks large files so no argument exceeds the kernel limit", () => {
    const big = "x".repeat(250 * 1024) + "END";
    const batches = buildWriteBatches([{ path: "big.py", content: big }]);
    const all = new Map<string, string>();
    let acc = "";
    for (const b of batches) {
      for (const arg of b.argv) expect(arg.length).toBeLessThan(128 * 1024);
      const args = b.argv.slice(4);
      for (let i = 0; i < args.length; i += 3) acc += Buffer.from(args[i + 2]!, "base64").toString("utf8");
    }
    all.set("big.py", acc);
    expect(all.get("big.py")).toBe(big);
  });

  it("keeps each batch under the total argv budget", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.c`, content: "y".repeat(200 * 1024) }));
    for (const b of buildWriteBatches(files)) {
      const total = b.argv.reduce((n, a) => n + a.length, 0);
      expect(total).toBeLessThan(1.2 * 1024 * 1024);
    }
  });
});
