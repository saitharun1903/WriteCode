import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { STREAM_FIELD, redisKeys, type ExecutionResult, type ExecutionStatus, type Trace, type TraceStep, type TraceValue } from "@cw/shared";
import { config } from "../config.js";
import { createDocker } from "../docker.js";
import type { EventEmitter } from "../events.js";
import { runExecution } from "../runner.js";

/**
 * Visualizer traces recorded by the real tracers (CPython settrace, JDI) in
 * real Docker sandboxes. Run with: E2E_EXECUTION=1 pnpm --filter @cw/worker test
 */
const enabled = !!process.env.E2E_EXECUTION;
const docker = createDocker(config.dockerHost);
const redis = enabled ? new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true }) : null;
afterAll(() => redis?.disconnect());

async function visualize(language: string, files: Record<string, string>, opts: { stdin?: string; typed?: string[] } = {}) {
  const executionId = randomUUID();
  let trace: Trace | undefined;
  const statuses: ExecutionStatus[] = [];
  const typed = [...(opts.typed ?? [])];
  const commandRedis = opts.typed ? redis!.duplicate() : undefined;
  const events = {
    status(s: ExecutionStatus) {
      statuses.push(s);
      const next = s === "WAITING_FOR_INPUT" ? typed.shift() : undefined;
      if (next) void redis!.xadd(redisKeys.commands(executionId), "*", STREAM_FIELD, JSON.stringify({ stdin: next, eof: false }));
    },
    chunk() {},
    debug() {},
    trace(t: Trace) {
      trace = t;
    },
    async result() {},
  } as unknown as EventEmitter;
  try {
    const result: ExecutionResult = await runExecution({
      docker,
      executionId,
      request: {
        language,
        files: Object.entries(files).map(([path, content]) => ({ path, content })),
        entry: Object.keys(files)[0]!,
        stdin: opts.stdin,
        interactive: !!opts.typed,
        mode: "visualize",
      },
      limits: config.limits,
      workspaceMb: config.workspaceMb,
      maxFileSizeBytes: config.maxFileSizeBytes,
      events,
      isCancelled: async () => false,
      log: () => {},
      commandRedis,
    });
    return { result, trace: trace!, statuses };
  } finally {
    commandRedis?.disconnect();
  }
}

const top = (s: TraceStep) => s.frames[s.frames.length - 1]!;
const local = (s: TraceStep, name: string, frame = s.frames.length - 1) => s.frames[frame]!.locals.find(([n]) => n === name)?.[1];
const text = (v: TraceValue | undefined) => (v?.kind === "value" ? v.text : undefined);
const T = 120_000;

describe.skipIf(!enabled).concurrent("visualizer traces", () => {
  it("Python: every line, frames, references to shared objects, return values and output offsets", { timeout: T }, async () => {
    const code = `class Node:
    def __init__(self, val, nxt=None):
        self.val = val
        self.next = nxt


def square(x):
    return x * x


shared = [1, 2]
alias = shared
head = Node(1, Node(2))
total = square(3)
print("total", total)
shared.append(total)
`;
    const { result, trace } = await visualize("python", { "main.py": code });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("total 9\n");
    expect(trace.language).toBe("python");
    expect(trace.stdout).toBe("total 9\n");
    expect(trace.truncated).toBeUndefined();

    const lines = trace.steps.filter((s) => s.event === "line" && top(s).name === "<module>").map((s) => top(s).line);
    expect(lines).toEqual([1, 7, 11, 12, 13, 14, 15, 16]);

    // Both names refer to the same list object.
    const at13 = trace.steps.find((s) => s.event === "line" && top(s).line === 13)!;
    const shared = local(at13, "shared")!;
    expect(shared).toEqual(local(at13, "alias"));
    expect(shared.kind).toBe("ref");
    expect(at13.heap[(shared as { id: string }).id]).toMatchObject({ kind: "sequence", type: "list", items: [{ text: "1" }, { text: "2" }] });

    // square(3) returns 9, seen on its return step.
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "square")!;
    expect(ret.frames.map((f) => f.name)).toEqual(["<module>", "square"]);
    expect(text(top(ret).returnValue)).toBe("9");

    // The linked list: head -> Node(1) -> Node(2).
    const at14 = trace.steps.find((s) => s.event === "line" && top(s).line === 14)!;
    const headObj = at14.heap[(local(at14, "head") as { id: string }).id]!;
    expect(headObj).toMatchObject({ kind: "object", type: "Node" });
    const next = headObj.fields!.find(([n]) => n === "next")![1] as { id: string };
    expect(at14.heap[next.id]!.fields!.find(([n]) => n === "val")![1]).toMatchObject({ text: "2" });

    // Output offsets: nothing printed before line 16, "total 9\n" after.
    const at15 = trace.steps.find((s) => s.event === "line" && top(s).line === 15)!;
    const at16 = trace.steps.find((s) => s.event === "line" && top(s).line === 16)!;
    expect(at15.stdoutLength).toBe(0);
    expect(at16.stdoutLength).toBe(8);
  });

  it("Python: an uncaught exception is recorded, then reported like a normal run", { timeout: T }, async () => {
    const { result, trace } = await visualize("python", { "main.py": "def div(a, b):\n    return a // b\n\n\nprint(div(7, 2))\nprint(div(1, 0))\n" });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.stdout).toBe("3\n");
    expect(result.stderr).toContain("ZeroDivisionError: integer division or modulo by zero");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("ZeroDivisionError: integer division or modulo by zero");
    expect(top(ex)).toMatchObject({ name: "div", line: 2 });
    expect(text(local(ex, "b"))).toBe("0");
  });

  it("Python: long programs are recorded up to the step limit and still finish", { timeout: T }, async () => {
    const { result, trace } = await visualize("python", { "main.py": "total = 0\nfor i in range(5000):\n    total += i\nprint(total)\n" });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("12497500\n");
    expect(trace.steps).toHaveLength(1000);
    expect(trace.truncated).toMatch(/after 1000 steps/);
  });

  it("Python: typed input while visualizing", { timeout: T }, async () => {
    const { result, trace, statuses } = await visualize("python", { "main.py": 'name = input("name? ")\nprint("hi", name)\n' }, { typed: ["Ada\n"] });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("name? hi Ada\n");
    expect(statuses).toContain("WAITING_FOR_INPUT");
    const at2 = trace.steps.find((s) => s.event === "line" && top(s).line === 2)!;
    expect(text(local(at2, "name"))).toBe("'Ada'");
  });

  it("Java: steps through methods and constructors across files with collections and objects", { timeout: T }, async () => {
    const files = {
      "Main.java": `import java.util.*;

public class Main {
    static int square(int x) {
        int r = x * x;
        return r;
    }

    public static void main(String[] args) {
        List<String> names = new ArrayList<>();
        names.add("ada");
        Map<String, Integer> ages = new HashMap<>();
        ages.put("ada", 36);
        Point p = new Point(1, 2);
        int total = square(3);
        System.out.println("total=" + total + " " + p.x);
    }
}
`,
      "Point.java": "public class Point {\n    int x, y;\n\n    Point(int x, int y) {\n        this.x = x;\n        this.y = y;\n    }\n}\n",
    };
    const { result, trace } = await visualize("java", files);
    expect(result.status, result.compileOutput + result.stderr).toBe("SUCCESS");
    expect(result.stdout).toBe("total=9 1\n");
    expect(trace.language).toBe("java");

    const mainLines = trace.steps.filter((s) => s.event === "line" && s.frames.length === 1).map((s) => top(s).line);
    expect(mainLines).toEqual(expect.arrayContaining([10, 11, 12, 13, 14, 15, 16, 17]));

    const ctor = trace.steps.find((s) => top(s).name === "Point.<init>" && top(s).line === 6)!;
    expect(ctor.frames.map((f) => `${f.name}@${f.file}`)).toEqual(["Main.main@Main.java", "Point.<init>@Point.java"]);
    const self = ctor.heap[(local(ctor, "this") as { id: string }).id]!;
    expect(self).toMatchObject({ kind: "object", type: "Point" });
    expect(self.fields).toEqual([
      ["x", { kind: "value", text: "1", type: "int" }],
      ["y", { kind: "value", text: "0", type: "int" }],
    ]);

    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "Main.square")!;
    expect(text(top(ret).returnValue)).toBe("9");

    const at16 = trace.steps.find((s) => s.event === "line" && s.frames.length === 1 && top(s).line === 16)!;
    const names = at16.heap[(local(at16, "names") as { id: string }).id]!;
    expect(names).toMatchObject({ kind: "sequence", type: "ArrayList", items: [{ text: '"ada"' }] });
    const ages = at16.heap[(local(at16, "ages") as { id: string }).id]!;
    expect(ages).toMatchObject({ kind: "map", type: "HashMap", entries: [[{ text: '"ada"' }, { text: "36" }]] });
    expect(text(local(at16, "total"))).toBe("9");
    expect(at16.stdoutLength).toBe(0);
    const at17 = trace.steps.find((s) => s.event === "line" && s.frames.length === 1 && top(s).line === 17)!;
    expect(at17.stdoutLength).toBe("total=9 1\n".length);
  });

  it("Java: ArrayDeque head to tail, and PriorityQueue in heap order", { timeout: T }, async () => {
    const code = [
      "import java.util.*;",
      "",
      "public class Main {",
      "    public static void main(String[] args) {",
      "        Deque<Integer> stack = new ArrayDeque<>();",
      "        for (int i = 1; i <= 20; i++) stack.push(i);",
      "        for (int i = 0; i < 17; i++) stack.pop();",
      "        stack.addLast(99);",
      "        PriorityQueue<Integer> pq = new PriorityQueue<>(List.of(5, 1, 4, 2));",
      "        System.out.println(stack.peek() + \" \" + pq.peek());",
      "    }",
      "}",
      "",
    ].join("\n");
    const { result, trace } = await visualize("java", { "Main.java": code });
    expect(result.status).toBe("SUCCESS");
    const last = trace.steps.filter((s) => local(s, "pq")).at(-1)!;
    const items = (name: string) => {
      const v = local(last, name);
      return v?.kind === "ref" ? last.heap[v.id]!.items!.map(text) : [];
    };
    // The buffer wrapped around after 20 pushes and 17 pops: still head (top) first.
    expect(items("stack")).toEqual(["3", "2", "1", "99"]);
    const pq = items("pq");
    expect(pq[0]).toBe("1");
    expect([...pq].sort()).toEqual(["1", "2", "4", "5"]);
  });

  it("JavaScript: frames, values, objects and output, exactly as a normal run", { timeout: T }, async () => {
    const code = [
      "class Node {",
      "  constructor(val) {",
      "    this.val = val;",
      "    this.next = null;",
      "  }",
      "}",
      "const head = new Node(1);",
      "head.next = new Node(2);",
      'const seen = new Map([["a", 1]]);',
      "function double(x) {",
      "  return x * 2;",
      "}",
      "const d = double(21);",
      "console.log(d);",
      "",
    ].join("\n");
    const { result, trace } = await visualize("javascript", { "main.js": code });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("42\n");
    expect(trace.language).toBe("javascript");
    expect(trace.steps[0]!.frames.map((f) => [f.name, f.line])).toEqual([["(top level)", 7]]);
    const ctor = trace.steps.find((s) => top(s).name === "new Node")!;
    expect(ctor.frames.map((f) => f.name)).toEqual(["(top level)", "new Node"]);
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "double")!;
    expect(ret.frames.at(-1)!.returnValue).toEqual({ kind: "value", text: "42", type: "number" });
    const last = trace.steps.at(-1)!;
    const headRef = local(last, "head", 0);
    const node = last.heap[(headRef as { id: string }).id]!;
    expect(node).toMatchObject({ kind: "object", type: "Node" });
    expect(node.fields!.map(([n]) => n)).toEqual(["val", "next"]);
    expect(last.heap[(local(last, "seen", 0) as { id: string }).id]).toMatchObject({ kind: "map", type: "Map" });
    expect(trace.stdout).toBe("42\n");
  });

  it("TypeScript: lines are the lines as written, even when enums are transformed", { timeout: T }, async () => {
    const code = ["enum Color {", "  Red,", "  Green,", "}", "", "function pick(c: Color): number {", "  const n: number = c + 1;", "  return n;", "}", "", "const r: number = pick(Color.Green);", "console.log(r);", ""].join("\n");
    const { result, trace } = await visualize("typescript", { "main.ts": code });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("2\n");
    const inPick = trace.steps.filter((s) => top(s).name === "pick").map((s) => top(s).line);
    expect(inPick).toContain(7);
    expect(inPick).toContain(8);
    expect(trace.steps.some((s) => s.frames.length === 1 && top(s).line === 11)).toBe(true);
  });

  it("JavaScript: an uncaught error is recorded and reported as Node reports it", { timeout: T }, async () => {
    const code = ["const a = [1];", "function f(x) {", '  if (x > 0) throw new Error("boom");', "}", "f(1);", ""].join("\n");
    const { result, trace } = await visualize("javascript", { "main.js": code });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.stderr).toContain("main.js:3");
    expect(result.stderr).toContain("Error: boom");
    expect(result.stderr).not.toContain("cw_trace");
    expect(trace.steps.some((s) => s.event === "exception" && /boom/.test(s.exception ?? ""))).toBe(true);
  });

  it("Java: typed input reaches the traced program", { timeout: T }, async () => {
    const code = "import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        int n = new Scanner(System.in).nextInt();\n        int doubled = n * 2;\n        System.out.println(doubled);\n    }\n}\n";
    const { result, trace, statuses } = await visualize("java", { "Main.java": code }, { typed: ["25\n"] });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("50\n");
    expect(statuses).toContain("WAITING_FOR_INPUT");
    const at7 = trace.steps.find((s) => s.event === "line" && top(s).line === 7)!;
    expect(text(local(at7, "doubled"))).toBe("50");
  });

  it("Ruby: frames, blocks, objects by reference, return values, required files and output", { timeout: T }, async () => {
    const main = [
      'require_relative "node"',
      "",
      "def total(head)",
      "  sum = 0",
      "  cur = head",
      "  while cur",
      "    sum += cur.value",
      "    cur = cur.next_node",
      "  end",
      "  sum",
      "end",
      "",
      "head = Node.new(1)",
      "head.next_node = Node.new(2)",
      "doubled = [3, 1].map { |x| x * 2 }",
      'scores = { "asha" => 91, ravi: [7, 8] }',
      'puts "total=#{total(head)}"',
      "",
    ].join("\n");
    const node = "class Node\n  attr_accessor :value, :next_node\n\n  def initialize(value)\n    @value = value\n    @next_node = nil\n  end\nend\n";
    const { result, trace } = await visualize("ruby", { "main.rb": main, "node.rb": node });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("total=3\n");
    expect(trace.language).toBe("ruby");
    expect(trace.stdout).toBe("total=3\n");
    // The required file runs as its own frame above the line that required it.
    expect(trace.steps[1]!.frames.map((f) => [f.name, f.file, f.line])).toEqual([
      ["<main>", "main.rb", 1],
      ["<top (required)>", "node.rb", 1],
    ]);
    expect(top(trace.steps[2]!)).toMatchObject({ name: "<class:Node>", file: "node.rb", line: 2 });
    // A constructor is Node#initialize, with self; its fields are read without @.
    const init = trace.steps.find((s) => top(s).name === "Node#initialize" && top(s).line === 6)!;
    expect(local(init, "self")).toMatchObject({ kind: "ref" });
    expect(text(local(init, "value"))).toBe("1");
    // A block is a frame of its own, with only its own variables.
    const block = trace.steps.find((s) => top(s).name === "block in <main>")!;
    expect(top(block).locals.map(([n]) => n)).toEqual(["x"]);
    expect(top(trace.steps.find((s) => s.event === "return" && top(s).name === "block in <main>")!).returnValue).toEqual({ kind: "value", text: "6", type: "Integer" });
    // The linked list: head and cur are the same object; next_node points to the second node.
    const loop = trace.steps.find((s) => top(s).name === "total" && top(s).line === 7)!;
    const head = local(loop, "head") as { kind: "ref"; id: string };
    expect(local(loop, "cur")).toEqual(head);
    expect(loop.heap[head.id]).toMatchObject({ kind: "object", type: "Node", fields: [["value", { text: "1" }], ["next_node", { kind: "ref" }]] });
    const after = trace.steps.find((s) => top(s).name === "<main>" && top(s).line === 17)!;
    const scores = after.heap[(local(after, "scores") as { id: string }).id]!;
    expect(scores).toMatchObject({ kind: "map", type: "Hash", entries: [[{ text: '"asha"' }, { text: "91" }], [{ text: ":ravi" }, { kind: "ref" }]] });
    expect(after.heap[(local(after, "doubled") as { id: string }).id]).toMatchObject({ kind: "sequence", type: "Array", items: [{ text: "6" }, { text: "2" }] });
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "total")!;
    expect(top(ret).returnValue).toEqual({ kind: "value", text: "3", type: "Integer" });
  });

  it("Ruby: an uncaught exception is recorded, then reported like a normal run; typed input reaches the program", { timeout: T }, async () => {
    const { result, trace } = await visualize("ruby", { "main.rb": 'def half(n)\n  raise ArgumentError, "odd: #{n}" if n.odd?\n  n / 2\nend\n\nputs half(4)\nputs half(3)\n' });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.stdout).toBe("2\n");
    expect(result.stderr).toContain("main.rb:2:in 'Object#half': odd: 3 (ArgumentError)");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("ArgumentError: odd: 3");
    expect(top(ex)).toMatchObject({ name: "half", line: 2 });
    expect(text(local(ex, "n"))).toBe("3");

    const typed = await visualize("ruby", { "main.rb": 'print "name? "\nname = gets.chomp\nputs "hi #{name}"\n' }, { typed: ["Ada\n"] });
    expect(typed.result.status).toBe("SUCCESS");
    expect(typed.result.stdout).toBe("name? hi Ada\n");
    expect(typed.statuses).toContain("WAITING_FOR_INPUT");
    const at3 = typed.trace.steps.find((s) => top(s).line === 3)!;
    expect(text(local(at3, "name"))).toBe('"Ada"');
    expect(at3.stdoutLength).toBe(6);
  });

  it("Rust: frames named as written, Vec, String, HashMap, structs linked through Option<Box<..>>, enums, tuples and return values", { timeout: 180_000 }, async () => {
    const main = [
      "use std::collections::HashMap;",
      "",
      "struct Node {",
      "    value: i32,",
      "    next: Option<Box<Node>>,",
      "}",
      "",
      "impl Node {",
      "    fn new(value: i32) -> Node {",
      "        Node { value, next: None }",
      "    }",
      "}",
      "",
      "enum Shape {",
      "    Circle(f64),",
      "    Dot,",
      "}",
      "",
      "fn square(x: i32) -> i32 {",
      "    let r = x * x;",
      "    r",
      "}",
      "",
      "fn main() {",
      "    let nums = vec![3, 1, 2];",
      '    let name = String::from("ada");',
      "    let mut total = 0;",
      "    for n in &nums {",
      "        total += square(*n);",
      "    }",
      "    let mut head = Node::new(1);",
      "    head.next = Some(Box::new(Node::new(2)));",
      "    let mut ages = HashMap::new();",
      '    ages.insert("ada", 36);',
      "    let pair = (7, 'x');",
      "    let shape = Shape::Circle(1.5);",
      "    let dot = Shape::Dot;",
      "    let found: Option<i32> = None;",
      '    println!("{} {} {}", total, name, head.value);',
      "}",
      "",
    ].join("\n");
    const { result, trace } = await visualize("rust", { "main.rs": main });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("14 ada 1\n");
    expect(trace.stdout).toBe("14 ada 1\n");
    expect(top(trace.steps[0]!)).toMatchObject({ name: "main", file: "main.rs", line: 25 });
    // The loop's own iterator is not one of the program's variables; n is the number it refers to.
    const inLoop = trace.steps.find((s) => top(s).name === "main" && top(s).line === 29)!;
    expect(top(inLoop).locals.map(([n]) => n)).not.toContain("iter");
    expect(local(inLoop, "n")).toEqual({ kind: "value", text: "3", type: "&i32" });
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "square")!;
    expect(top(ret).returnValue).toEqual({ kind: "value", text: "9", type: "i32" });
    expect(trace.steps.some((s) => top(s).name === "Node::new")).toBe(true);

    const end = trace.steps.findLast((s) => top(s).name === "main" && top(s).line === 39)!;
    const heap = end.heap;
    const ref = (name: string) => heap[(local(end, name) as { id: string }).id]!;
    expect(ref("nums")).toMatchObject({ kind: "sequence", type: "Vec<i32>", items: [{ text: "3" }, { text: "1" }, { text: "2" }] });
    expect(local(end, "name")).toMatchObject({ kind: "value", text: '"ada"' });
    // The list: head's next is the second node itself (Some(Box) unwrapped); the second's next is None.
    const head = ref("head");
    expect(head).toMatchObject({ kind: "object", type: "Node", fields: [["value", { text: "1" }], ["next", { kind: "ref" }]] });
    const second = heap[(head.fields![1]![1] as { id: string }).id]!;
    expect(second).toMatchObject({ kind: "object", type: "Node", fields: [["value", { text: "2" }], ["next", { kind: "value", text: "None" }]] });
    expect(ref("ages")).toMatchObject({ kind: "map", type: "HashMap<&str, i32>", entries: [[{ text: '"ada"' }, { text: "36" }]] });
    expect(ref("pair")).toMatchObject({ kind: "sequence", type: "(i32, char)", items: [{ text: "7" }, { text: "'x'" }] });
    expect(ref("shape")).toMatchObject({ kind: "object", type: "Shape::Circle", fields: [["0", { text: "1.5" }]] });
    expect(local(end, "dot")).toMatchObject({ kind: "value", text: "Shape::Dot" });
    expect(local(end, "found")).toMatchObject({ kind: "value", text: "None" });
  });

  it("Rust: a panic is recorded where the program's code panicked, then reported like a normal run", { timeout: 180_000 }, async () => {
    const { result, trace } = await visualize("rust", { "main.rs": "fn take(xs: &Vec<i32>, i: usize) -> i32 {\n    xs[i]\n}\n\nfn main() {\n    let xs = vec![1, 2];\n    println!(\"{}\", take(&xs, 0));\n    println!(\"{}\", take(&xs, 5));\n}\n" });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.exitCode).toBe(101);
    expect(result.stdout).toBe("1\n");
    expect(result.stderr).toContain("index out of bounds: the len is 2 but the index is 5");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("panic: index out of bounds: the len is 2 but the index is 5");
    expect(top(ex)).toMatchObject({ name: "take", line: 2 });
    expect(local(ex, "i")).toMatchObject({ text: "5" });
  });

  it("Go: frames, slices, maps, structs linked by pointers, return values and output, across files", { timeout: 180_000 }, async () => {
    const main = [
      "package main",
      "",
      'import "fmt"',
      "",
      "func square(x int) int {",
      "\tr := x * x",
      "\treturn r",
      "}",
      "",
      "func main() {",
      "\tnums := []int{3, 1, 2}",
      '\tages := map[string]int{"ada": 36}',
      "\thead := &Node{Value: 1}",
      "\thead.Next = &Node{Value: 2}",
      "\tp := Point{1, 2}",
      "\ttotal := 0",
      "\tfor _, n := range nums {",
      "\t\ttotal += square(n)",
      "\t}",
      '\tfmt.Println("total", total, len(ages), p.X)',
      "}",
      "",
    ].join("\n");
    const types = "package main\n\ntype Node struct {\n\tValue int\n\tNext  *Node\n}\n\ntype Point struct{ X, Y int }\n";
    const { result, trace } = await visualize("go", { "main.go": main, "types.go": types });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("total 14 1 1\n");
    expect(trace.language).toBe("go");
    expect(trace.stdout).toBe("total 14 1 1\n");
    expect(top(trace.steps[0]!)).toMatchObject({ name: "main", file: "main.go", line: 11 });
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "square")!;
    expect(top(ret).returnValue).toEqual({ kind: "value", text: "9", type: "int" });
    const end = trace.steps.findLast((s) => top(s).name === "main" && top(s).line === 20)!;
    const ref = (name: string) => end.heap[(local(end, name) as { id: string }).id]!;
    expect(ref("nums")).toMatchObject({ kind: "sequence", type: "[]int", items: [{ text: "3" }, { text: "1" }, { text: "2" }] });
    expect(ref("ages")).toMatchObject({ kind: "map", type: "map[string]int", entries: [[{ text: '"ada"' }, { text: "36" }]] });
    expect(ref("p")).toMatchObject({ kind: "object", type: "Point", fields: [["X", { text: "1" }], ["Y", { text: "2" }]] });
    // head is a pointer: it refers to the node itself, whose Next is the second node, whose Next is nil.
    const head = ref("head");
    expect(head).toMatchObject({ kind: "object", type: "Node", fields: [["Value", { text: "1" }], ["Next", { kind: "ref" }]] });
    expect(end.heap[(head.fields![1]![1] as { id: string }).id]).toMatchObject({ kind: "object", type: "Node", fields: [["Value", { text: "2" }], ["Next", { kind: "value", text: "nil" }]] });
    expect(text(local(end, "total"))).toBe("14");
  });

  it("Go: a panic is recorded where the program's code panicked; typed input reaches the program", { timeout: 180_000 }, async () => {
    const { result, trace } = await visualize("go", { "main.go": 'package main\n\nimport "fmt"\n\nfunc at(xs []int, i int) int {\n\treturn xs[i]\n}\n\nfunc main() {\n\txs := []int{1, 2}\n\tfmt.Println(at(xs, 0))\n\tfmt.Println(at(xs, 5))\n}\n' });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("1\n");
    expect(result.stderr).toContain("panic: runtime error: index out of range [5] with length 2");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("panic: runtime error: index out of range [5] with length 2");
    expect(top(ex)).toMatchObject({ name: "at", line: 6 });
    expect(text(local(ex, "i"))).toBe("5");

    const typed = await visualize("go", { "main.go": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar name string\n\tfmt.Print("name? ")\n\tfmt.Scan(&name)\n\tfmt.Println("hi", name)\n}\n' }, { typed: ["Ada\n"] });
    expect(typed.result.status).toBe("SUCCESS");
    expect(typed.result.stdout).toBe("name? hi Ada\n");
    expect(typed.statuses).toContain("WAITING_FOR_INPUT");
    const at9 = typed.trace.steps.find((s) => top(s).line === 9)!;
    expect(text(local(at9, "name"))).toBe('"Ada"');
    expect(at9.stdoutLength).toBe(6);
  });

  it("PHP: frames, arrays as lists and tables, objects by identity, return values and output, across files", { timeout: 180_000 }, async () => {
    const main = [
      "<?php",
      'require_once "node.php";',
      "",
      "function square($x) {",
      "    $r = $x * $x;",
      "    return $r;",
      "}",
      "",
      "$nums = [3, 1, 2];",
      '$ages = ["ada" => 36];',
      "$head = new Node(1);",
      "$head->next = new Node(2);",
      "$alias = $head;",
      "$total = 0;",
      "foreach ($nums as $n) {",
      "    $total += square($n);",
      "}",
      'echo "total=$total\n";',
      "",
    ].join("\n");
    const node = "<?php\nclass Node {\n    public $value;\n    public $next = null;\n\n    public function __construct($value) {\n        $this->value = $value;\n    }\n}\n";
    const { result, trace } = await visualize("php", { "main.php": main, "node.php": node });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("total=14\n");
    expect(trace.language).toBe("php");
    expect(trace.stdout).toBe("total=14\n");
    expect(top(trace.steps[0]!)).toMatchObject({ name: "<main>", file: "main.php", line: 2 });
    expect(trace.steps.some((s) => top(s).name === "Node->__construct" && top(s).file === "node.php")).toBe(true);
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "square")!;
    expect(top(ret).returnValue).toEqual({ kind: "value", text: "9", type: "int" });
    const end = trace.steps.findLast((s) => top(s).line === 18)!;
    // In the order they were written, not alphabetically.
    expect(top(end).locals.map(([n]) => n)).toEqual(["nums", "ages", "head", "alias", "total", "n"]);
    const ref = (name: string) => end.heap[(local(end, name) as { id: string }).id]!;
    expect(ref("nums")).toMatchObject({ kind: "sequence", type: "array", items: [{ text: "3" }, { text: "1" }, { text: "2" }] });
    expect(ref("ages")).toMatchObject({ kind: "map", type: "array", entries: [[{ text: '"ada"' }, { text: "36" }]] });
    // $alias is $head: one object. Its next is the second node, whose next is null.
    expect(local(end, "alias")).toEqual(local(end, "head"));
    const head = ref("head");
    expect(head).toMatchObject({ kind: "object", type: "Node", fields: [["value", { text: "1" }], ["next", { kind: "ref" }]] });
    expect(end.heap[(head.fields![1]![1] as { id: string }).id]).toMatchObject({ kind: "object", type: "Node", fields: [["value", { text: "2" }], ["next", { kind: "value", text: "null" }]] });
  });

  it("PHP: an exception is recorded where it is thrown, then reported like a normal run; typed input reaches the program", { timeout: 180_000 }, async () => {
    const { result, trace } = await visualize("php", { "main.php": '<?php\nfunction half($n) {\n    if ($n % 2) {\n        throw new InvalidArgumentException("odd: $n");\n    }\n    return intdiv($n, 2);\n}\n\necho half(4), "\\n";\necho half(3), "\\n";\n' });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.stdout).toBe("2\n");
    expect(result.stderr).toContain("Uncaught InvalidArgumentException: odd: 3");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("InvalidArgumentException: odd: 3");
    expect(top(ex)).toMatchObject({ name: "half", line: 4 });
    expect(text(local(ex, "n"))).toBe("3");

    const typed = await visualize("php", { "main.php": '<?php\necho "name? ";\n$name = trim(fgets(STDIN));\necho "hi $name\\n";\n' }, { typed: ["Ada\n"] });
    expect(typed.result.status).toBe("SUCCESS");
    expect(typed.result.stdout).toBe("name? hi Ada\n");
    expect(typed.statuses).toContain("WAITING_FOR_INPUT");
    const at4 = typed.trace.steps.find((s) => top(s).line === 4)!;
    expect(text(local(at4, "name"))).toBe('"Ada"');
    expect(at4.stdoutLength).toBe(6);
  });

  it("C#: frames, List, Dictionary and arrays as their elements, objects by identity, return values and output, across files", { timeout: 180_000 }, async () => {
    const program = [
      "class Program",
      "{",
      "    static int Square(int x)",
      "    {",
      "        int r = x * x;",
      "        return r;",
      "    }",
      "",
      "    static void Main()",
      "    {",
      "        var nums = new List<int> { 3, 1, 2 };",
      '        var ages = new Dictionary<string, int> { ["ada"] = 36 };',
      "        int[] pair = { 7, 8 };",
      "        var head = new Node(1);",
      "        head.Next = new Node(2);",
      "        var cur = head;",
      "        int total = 0;",
      "        foreach (var n in nums)",
      "        {",
      "            total += Square(n);",
      "        }",
      '        Console.WriteLine($"total {total}");',
      "    }",
      "}",
      "",
    ].join("\n");
    const node = "class Node\n{\n    public int Value;\n    public Node Next;\n\n    public Node(int value)\n    {\n        Value = value;\n    }\n}\n";
    const { result, trace } = await visualize("csharp", { "Program.cs": program, "Node.cs": node });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("total 14\n");
    expect(trace.language).toBe("csharp");
    expect(trace.stdout).toBe("total 14\n");
    expect(top(trace.steps[0]!)).toMatchObject({ name: "Program.Main", file: "Program.cs", line: 11 });
    // A constructor is Node.Node, in its own file; braces are not steps.
    expect(trace.steps.some((s) => top(s).name === "Node.Node" && top(s).file === "Node.cs" && top(s).line === 8)).toBe(true);
    expect(trace.steps.some((s) => ["{", "}"].includes(program.split("\n")[top(s).line - 1]!.trim()) && top(s).file === "Program.cs" && s.event === "line")).toBe(false);
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "Program.Square")!;
    expect(top(ret).returnValue).toEqual({ kind: "value", text: "9", type: "int" });
    // Locals appear once their declaration has run.
    const early = trace.steps.find((s) => top(s).name === "Program.Main" && top(s).line === 13)!;
    expect(top(early).locals.map(([n]) => n)).toEqual(["nums", "ages"]);
    const end = trace.steps.findLast((s) => top(s).name === "Program.Main" && top(s).line === 22)!;
    const ref = (name: string) => end.heap[(local(end, name) as { id: string }).id]!;
    expect(ref("nums")).toMatchObject({ kind: "sequence", type: "List<int>", items: [{ text: "3" }, { text: "1" }, { text: "2" }] });
    expect(ref("ages")).toMatchObject({ kind: "map", type: "Dictionary<string, int>", entries: [[{ text: '"ada"' }, { text: "36" }]] });
    expect(ref("pair")).toMatchObject({ kind: "sequence", type: "int[]", items: [{ text: "7" }, { text: "8" }] });
    // cur is head: one object, whose Next is the second node, whose Next is null.
    expect(local(end, "cur")).toEqual(local(end, "head"));
    const head = ref("head");
    expect(head).toMatchObject({ kind: "object", type: "Node", fields: [["Value", { text: "1" }], ["Next", { kind: "ref" }]] });
    expect(end.heap[(head.fields![1]![1] as { id: string }).id]).toMatchObject({ kind: "object", type: "Node", fields: [["Value", { text: "2" }], ["Next", { kind: "value", text: "null" }]] });
    expect(text(local(end, "total"))).toBe("14");
  });

  it("C#: an exception is recorded where it is thrown, then reported like a normal run; typed input reaches the program", { timeout: 180_000 }, async () => {
    const { result, trace } = await visualize("csharp", { "Program.cs": 'class Program\n{\n    static int At(int[] xs, int i)\n    {\n        return xs[i];\n    }\n\n    static void Main()\n    {\n        int[] xs = { 1, 2 };\n        Console.WriteLine(At(xs, 0));\n        Console.WriteLine(At(xs, 5));\n    }\n}\n' });
    expect(result.status).toBe("RUNTIME_ERROR");
    expect(result.stdout).toBe("1\n");
    expect(result.stderr).toContain("System.IndexOutOfRangeException: Index was outside the bounds of the array.");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("IndexOutOfRangeException: Index was outside the bounds of the array.");
    expect(top(ex)).toMatchObject({ name: "Program.At", line: 5 });
    expect(text(local(ex, "i"))).toBe("5");

    const typed = await visualize("csharp", { "Program.cs": 'Console.Write("name? ");\nstring name = Console.ReadLine();\nConsole.WriteLine($"hi {name}");\n' }, { typed: ["Ada\n"] });
    expect(typed.result.status).toBe("SUCCESS");
    expect(typed.result.stdout).toBe("name? hi Ada\n");
    expect(typed.statuses).toContain("WAITING_FOR_INPUT");
    const at3 = typed.trace.steps.find((s) => top(s).line === 3)!;
    expect(text(local(at3, "name"))).toBe('"Ada"');
    expect(at3.stdoutLength).toBe(6);
  });

  it("Bash: commands, functions called in $( ), arrays and associative arrays, the script's $? and output, across files", { timeout: 180_000 }, async () => {
    const main = [
      "#!/bin/bash",
      "source ./lib.sh",
      "",
      "nums=(3 1 2)",
      "declare -A ages=([ada]=36)",
      'name="Ada Lovelace"',
      "total=0",
      'for n in "${nums[@]}"; do',
      '  total=$((total + $(square "$n")))',
      "done",
      "false",
      'echo "status $? total $total"',
      "",
    ].join("\n");
    const lib = 'square() {\n  local x=$1\n  echo $((x * x))\n}\n';
    const { result, trace } = await visualize("bash", { "main.sh": main, "lib.sh": lib });
    expect(result.status).toBe("SUCCESS");
    expect(result.stdout).toBe("status 1 total 14\n");
    expect(trace.language).toBe("bash");
    expect(trace.stdout).toBe("status 1 total 14\n");
    // A function called in $( ) is a frame of its own, in its file (not on its header line).
    const inSquare = trace.steps.find((s) => top(s).name === "square")!;
    expect(inSquare.frames.map((f) => [f.name, f.file])).toEqual([["main", "main.sh"], ["square", "lib.sh"]]);
    expect(top(inSquare).line).toBe(2);
    const at3 = trace.steps.find((s) => top(s).name === "square" && top(s).line === 3)!;
    expect(local(at3, "x")).toEqual({ kind: "value", text: "3", type: "integer" });
    // The script's variables in its own frame, in the order it wrote them.
    const end = trace.steps.findLast((s) => top(s).name === "main" && top(s).line === 12)!;
    expect(top(end).locals.map(([n]) => n)).toEqual(["nums", "ages", "name", "total", "n"]);
    expect(end.heap[(local(end, "nums") as { id: string }).id]).toMatchObject({ kind: "sequence", items: [{ text: "3" }, { text: "1" }, { text: "2" }] });
    expect(end.heap[(local(end, "ages") as { id: string }).id]).toMatchObject({ kind: "map", entries: [[{ text: '"ada"' }, { text: "36" }]] });
    expect(local(end, "name")).toEqual({ kind: "value", text: '"Ada Lovelace"', type: "string" });
    expect(text(local(end, "total"))).toBe("14");
  });

  it("Bash: a command that is not found is recorded where it happened; typed input reaches the script", { timeout: 180_000 }, async () => {
    const { result, trace } = await visualize("bash", { "main.sh": 'echo start\nnosuchcommand --flag\necho after\n' });
    expect(result.stdout).toBe("start\nafter\n");
    expect(result.stderr).toContain("main.sh: line 2: nosuchcommand: command not found");
    const ex = trace.steps.find((s) => s.event === "exception")!;
    expect(ex.exception).toBe("command not found: nosuchcommand");
    expect(top(ex).line).toBe(2);

    const typed = await visualize("bash", { "main.sh": 'echo -n "name? "\nread -r name\necho "hi $name"\n' }, { typed: ["Ada\n"] });
    expect(typed.result.status).toBe("SUCCESS");
    expect(typed.result.stdout).toBe("name? hi Ada\n");
    expect(typed.statuses).toContain("WAITING_FOR_INPUT");
    const at3 = typed.trace.steps.find((s) => top(s).line === 3)!;
    expect(text(local(at3, "name"))).toBe('"Ada"');
    expect(at3.stdoutLength).toBe(6);
  });

  it("Kotlin: recorded by the JVM tracer, with its own functions, classes and collections", { timeout: 180_000 }, async () => {
    const files = {
      "Main.kt":
        'class Node(val value: Int) {\n    var next: Node? = null\n}\n\nfun total(head: Node?): Int {\n    var sum = 0\n    var cur = head\n    while (cur != null) {\n        sum += cur.value\n        cur = cur.next\n    }\n    return sum\n}\n\nfun main() {\n    val head = Node(1)\n    head.next = Node(2)\n    val names = mutableListOf("ada")\n    val t = total(head)\n    println("total=$t ${names.size}")\n}\n',
    };
    const { result, trace } = await visualize("kotlin", files);
    expect(result.status, result.compileOutput + result.stderr).toBe("SUCCESS");
    expect(result.stdout).toBe("total=3 1\n");
    // Every step is in the program's own file: none inside Kotlin's library.
    expect(new Set(trace.steps.flatMap((s) => s.frames.map((f) => f.file)))).toEqual(new Set(["Main.kt"]));
    const inTotal = trace.steps.find((s) => s.event === "line" && s.frames.length === 2 && top(s).line === 9)!;
    expect(inTotal.frames.map((f) => f.name)).toEqual(["MainKt.main", "MainKt.total"]);
    expect(text(local(inTotal, "sum"))).toBe("0");
    const cur = inTotal.heap[(local(inTotal, "cur") as { id: string }).id]!;
    expect(cur).toMatchObject({ kind: "object", type: "Node" });
    expect(cur.fields!.map(([name]) => name)).toEqual(["value", "next"]);
    const ret = trace.steps.find((s) => s.event === "return" && top(s).name === "MainKt.total")!;
    expect(text(top(ret).returnValue)).toBe("3");
    const last = trace.steps.filter((s) => s.event === "line" && s.frames.length === 1).at(-1)!;
    expect(last.heap[(local(last, "names") as { id: string }).id]).toMatchObject({ kind: "sequence", items: [{ text: '"ada"' }] });
  });
});
