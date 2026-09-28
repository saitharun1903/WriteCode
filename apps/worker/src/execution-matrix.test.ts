import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { STREAM_FIELD, redisKeys, type ExecutionResult, type ExecutionStatus } from "@cw/shared";
import { config } from "./config.js";
import { createDocker } from "./docker.js";
import type { EventEmitter } from "./events.js";
import { runExecution } from "./runner.js";

/**
 * Execution matrix: real programs in every supported language, compiled and
 * run by the real worker code in real Docker sandboxes with the production
 * limits. Expected output is what the language's own toolchain prints.
 *
 * Requires Docker with the sandbox images, and Redis for interactive input.
 * Run with: E2E_EXECUTION=1 pnpm --filter @cw/worker test
 */
const enabled = !!process.env.E2E_EXECUTION;
const docker = createDocker(config.dockerHost);
const redis = enabled ? new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true }) : null;

afterAll(async () => {
  redis?.disconnect();
});

type Files = Record<string, string>;
interface RunOptions {
  entry?: string;
  stdin?: string;
  /** Interactive run: each item is sent when the program next waits for input ("<EOF>" closes stdin). */
  typed?: string[];
  /** Delay before sending each typed item, to prove waits are not counted as run time. */
  typeDelayMs?: number;
  cancelAfterMs?: number;
  /** Test mode: one stdin per test. */
  tests?: string[];
}
interface Outcome {
  result: ExecutionResult;
  statuses: ExecutionStatus[];
  stdinEcho: string;
}

async function run(language: string, files: Files, opts: RunOptions = {}): Promise<Outcome> {
  const executionId = randomUUID();
  const statuses: ExecutionStatus[] = [];
  let stdinEcho = "";
  const tested: number[] = [];
  const typed = [...(opts.typed ?? [])];
  const interactive = opts.typed !== undefined;
  let cancelled = false;
  const commandRedis = interactive ? redis!.duplicate() : undefined;

  const send = async () => {
    const next = typed.shift();
    if (next === undefined) return;
    if (opts.typeDelayMs) await new Promise((r) => setTimeout(r, opts.typeDelayMs));
    const payload = next === "<EOF>" ? { stdin: "", eof: true } : { stdin: next, eof: false };
    await redis!.xadd(redisKeys.commands(executionId), "*", STREAM_FIELD, JSON.stringify(payload));
  };
  const events = {
    status(s: ExecutionStatus) {
      statuses.push(s);
      if (s === "WAITING_FOR_INPUT") void send();
    },
    chunk(type: string, text: string) {
      if (type === "stdin") stdinEcho += text;
    },
    debug() {},
    test(t: { index: number }) {
      tested.push(t.index);
    },
    async result() {},
  } as unknown as EventEmitter;

  if (opts.cancelAfterMs) setTimeout(() => (cancelled = true), opts.cancelAfterMs);
  const entry = opts.entry ?? Object.keys(files)[0]!;
  try {
    const result = await runExecution({
      docker,
      executionId,
      request: {
        language,
        files: Object.entries(files).map(([path, content]) => ({ path, content })),
        entry,
        stdin: opts.stdin,
        interactive,
        ...(opts.tests ? { mode: "test" as const, tests: opts.tests } : {}),
      },
      limits: config.limits,
      runtime: config.runtime,
      workspaceMb: config.workspaceMb,
      maxFileSizeBytes: config.maxFileSizeBytes,
      events,
      isCancelled: async () => cancelled,
      log: () => {},
      commandRedis,
    });
    if (opts.tests) expect(tested).toEqual((result.tests ?? []).map((t) => t.index));
    return { result, statuses, stdinEcho };
  } finally {
    commandRedis?.disconnect();
    await redis?.del(redisKeys.commands(executionId));
  }
}

/** Every sandbox container must be gone shortly after its run. */
async function expectCleanedUp(id: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const left = await docker.listContainers({ all: true, filters: { label: [`cw.execution=${id}`] } });
    if (left.length === 0) return;
    if (Date.now() > deadline) throw new Error(`container for ${id} still present`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const T = 90_000;
const expectOk = (o: Outcome, stdout: string) => {
  expect(o.result.stderr, o.result.compileOutput).toBe("");
  expect(o.result.status, o.result.compileOutput + o.result.stderr).toBe("SUCCESS");
  expect(o.result.stdout).toBe(stdout);
};

// ================================================================== Java

const JAVA_STUDENT = String.raw`public class Student {
    private final String name;
    private final int[] marks;

    public Student(String name, int... marks) {
        this.name = name;
        this.marks = marks;
    }

    public String getName() {
        return name;
    }

    public int[] getMarks() {
        return marks;
    }
}
`;
const JAVA_CALCULATOR = String.raw`public class Calculator {
    public int total(Student s) {
        int sum = 0;
        for (int m : s.getMarks()) {
            sum += m;
        }
        return sum;
    }

    public double average(Student s) {
        return (double) total(s) / s.getMarks().length;
    }
}
`;
const JAVA_MAIN = String.raw`public class Main {
    public static void main(String[] args) {
        Student ada = new Student("Ada", 90, 85, 77);
        Calculator calc = new Calculator();
        int total = calc.total(ada);
        System.out.println(ada.getName() + " total=" + total + " avg=" + calc.average(ada));
    }
}
`;

const main = (body: string, imports = "") => `${imports}public class Main {\n    public static void main(String[] args) throws Exception {\n${body}\n    }\n}\n`;

describe.skipIf(!enabled).concurrent("Java programs", () => {
  it("hello world", { timeout: T }, async () => {
    expectOk(await run("java", { "Main.java": main(`        System.out.println("Hello World");`) }), "Hello World\n");
  });

  it("the prompt's arithmetic, then a real runtime exception", { timeout: T }, async () => {
    expectOk(await run("java", { "Main.java": main(`        int a = 100;\n        int b = 250;\n        System.out.println(a + b);`) }), "350\n");
    const o = await run("java", { "Main.java": main(`        System.out.println("Sai");\n        System.out.println(100 / 0);`) });
    expect(o.result.status).toBe("RUNTIME_ERROR");
    expect(o.result.exitCode).toBe(1);
    expect(o.result.stdout).toBe("Sai\n");
    expect(o.result.stderr).toContain('Exception in thread "main" java.lang.ArithmeticException: / by zero');
    expect(o.result.stderr).toContain("at Main.main(Main.java:4)");
  });

  it("Scanner input", { timeout: T }, async () => {
    const code = main(
      `        java.util.Scanner sc = new java.util.Scanner(System.in);\n        int n = sc.nextInt();\n        long sum = 0;\n        for (int i = 0; i < n; i++) sum += sc.nextInt();\n        String name = sc.next();\n        System.out.println("sum=" + sum + " name=" + name);`,
    );
    expectOk(await run("java", { "Main.java": code }, { stdin: "4\n10 20 30 40\nAda\n" }), "sum=100 name=Ada\n");
  });

  it("loops with continue, do/while and labelled break", { timeout: T }, async () => {
    const code = main(String.raw`        int total = 0;
        for (int i = 1; i <= 10; i++) { if (i % 2 == 0) continue; total += i; }
        int k = 0;
        while (k < 5) k++;
        do { k--; } while (k > 2);
        StringBuilder sb = new StringBuilder();
        outer:
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                if (j == 2) continue outer;
                if (i == 2) break outer;
                sb.append(i).append(j).append(' ');
            }
        }
        System.out.println(total + " " + k + " " + sb.toString().trim());`);
    expectOk(await run("java", { "Main.java": code }), "25 2 00 01 10 11\n");
  });

  it("arrays and 2D arrays", { timeout: T }, async () => {
    const code = main(String.raw`        int[] a = {5, 3, 9, 1, 7};
        java.util.Arrays.sort(a);
        System.out.println(java.util.Arrays.toString(a));
        int[][] m = new int[3][4];
        for (int i = 0; i < 3; i++) for (int j = 0; j < 4; j++) m[i][j] = i * j;
        int s = 0;
        for (int[] row : m) for (int v : row) s += v;
        System.out.println(s + " " + m[2][3] + " " + a.length);`);
    expectOk(await run("java", { "Main.java": code }), "[1, 3, 5, 7, 9]\n18 6 5\n");
  });

  it("ArrayList and HashMap", { timeout: T }, async () => {
    const code = main(
      String.raw`        List<String> names = new ArrayList<>(List.of("bob", "alice", "carol"));
        names.add("dave");
        names.remove("bob");
        Collections.sort(names);
        System.out.println(names + " " + names.size() + " " + names.contains("carol"));
        Map<String, Integer> counts = new HashMap<>();
        for (String w : "the cat and the hat and the bat".split(" ")) counts.merge(w, 1, Integer::sum);
        System.out.println(new TreeMap<>(counts));
        System.out.println(counts.get("the") + " " + counts.getOrDefault("dog", 0));`,
      "import java.util.*;\n\n",
    );
    expectOk(await run("java", { "Main.java": code }), "[alice, carol, dave] 3 true\n{and=2, bat=1, cat=1, hat=1, the=3}\n3 0\n");
  });

  it("methods: overloading, varargs, pass-by-value", { timeout: T }, async () => {
    const code = String.raw`public class Main {
    static int add(int a, int b) { return a + b; }
    static double add(double a, double b) { return a + b; }
    static int sum(int... xs) { int s = 0; for (int x : xs) s += x; return s; }
    static void bump(int[] arr, int x) { arr[0]++; x++; }
    public static void main(String[] args) {
        int[] arr = {1};
        int x = 1;
        bump(arr, x);
        System.out.println(add(2, 3) + " " + add(1.5, 2.25) + " " + sum(1, 2, 3, 4) + " " + arr[0] + " " + x);
    }
}
`;
    expectOk(await run("java", { "Main.java": code }), "5 3.75 10 2 1\n");
  });

  it("recursion", { timeout: T }, async () => {
    const code = String.raw`public class Main {
    static int fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    static long fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
    static int hanoi(int n) { return n == 0 ? 0 : 2 * hanoi(n - 1) + 1; }
    static long deep(int n) { return n == 0 ? 0 : n + deep(n - 1); }
    public static void main(String[] args) {
        System.out.println(fib(20) + " " + fact(10) + " " + hanoi(10) + " " + deep(5000));
    }
}
`;
    expectOk(await run("java", { "Main.java": code }), "6765 3628800 1023 12502500\n");
  });

  it("classes, inheritance, abstract classes and interfaces", { timeout: T }, async () => {
    const code = String.raw`import java.util.*;

abstract class Shape {
    abstract double area();
    String name() { return getClass().getSimpleName(); }
}

class Circle extends Shape {
    final double r;
    Circle(double r) { this.r = r; }
    double area() { return Math.PI * r * r; }
}

class Rect extends Shape {
    final double w, h;
    Rect(double w, double h) { this.w = w; this.h = h; }
    double area() { return w * h; }
}

class Square extends Rect {
    Square(double s) { super(s, s); }
    @Override String name() { return "Square(" + super.name() + ")"; }
}

interface Greeter {
    String greet(String n);
    default String twice(String n) { return greet(n) + greet(n); }
}

class Person implements Comparable<Person> {
    final String name;
    final int age;
    Person(String n, int a) { name = n; age = a; }
    public int compareTo(Person o) { return Integer.compare(age, o.age); }
    public String toString() { return name + ":" + age; }
}

public class Main {
    public static void main(String[] args) {
        for (Shape s : List.of(new Circle(1), new Rect(2, 3), new Square(2))) System.out.printf("%s %.2f%n", s.name(), s.area());
        Greeter g = n -> "hi " + n + ";";
        List<Person> ps = new ArrayList<>(List.of(new Person("Ann", 31), new Person("Bo", 25), new Person("Cy", 40)));
        Collections.sort(ps);
        System.out.println(g.twice("x") + " " + ps);
    }
}
`;
    expectOk(await run("java", { "Main.java": code }), "Circle 3.14\nRect 6.00\nSquare(Square) 4.00\nhi x;hi x; [Bo:25, Ann:31, Cy:40]\n");
  });

  it("checked, unchecked and try-with-resources exceptions", { timeout: T }, async () => {
    const code = String.raw`class InsufficientFunds extends Exception {
    InsufficientFunds(String m) { super(m); }
}

public class Main {
    static void withdraw(int bal, int amt) throws InsufficientFunds {
        if (amt > bal) throw new InsufficientFunds("need " + (amt - bal) + " more");
    }

    public static void main(String[] args) {
        StringBuilder log = new StringBuilder();
        try { withdraw(10, 25); } catch (InsufficientFunds e) { log.append("caught:").append(e.getMessage()); } finally { log.append(";finally"); }
        try { Object o = "s"; Integer i = (Integer) o; } catch (ClassCastException e) { log.append(";cce"); }
        try (AutoCloseable r = () -> System.out.println("closed")) { log.append(";body"); } catch (Exception e) { }
        System.out.println(log);
    }
}
`;
    expectOk(await run("java", { "Main.java": code }), "closed\ncaught:need 15 more;finally;cce;body\n");
  });

  it("enums, generics, records, nested and inner classes, switch expressions, streams, text blocks", { timeout: T }, async () => {
    const code = String.raw`import java.util.*;
import java.util.stream.*;

public class Main {
    enum Level { LOW, MEDIUM, HIGH; Level next() { return values()[(ordinal() + 1) % values().length]; } }
    record Pair<A, B>(A first, B second) {}
    static <T extends Comparable<T>> T max(List<T> xs) { T best = xs.get(0); for (T x : xs) if (x.compareTo(best) > 0) best = x; return best; }
    class Counter { int n; void inc() { n++; } }
    static class Box<T> { private final T v; Box(T v) { this.v = v; } T get() { return v; } }

    public static void main(String[] args) {
        String label = switch (Level.HIGH.next()) { case LOW -> "low"; case MEDIUM -> "mid"; case HIGH -> "high"; };
        var pair = new Pair<>("k", 7);
        Counter c = new Main().new Counter();
        c.inc();
        c.inc();
        List<Integer> evens = IntStream.rangeClosed(1, 10).filter(i -> i % 2 == 0).boxed().collect(Collectors.toList());
        String text = """
            a
            b""";
        System.out.println(label + " " + pair + " " + max(List.of(3, 9, 4)) + " " + c.n + " " + new Box<>("x").get() + " " + evens + " " + text.lines().count());
    }
}
`;
    expectOk(await run("java", { "Main.java": code }), "low Pair[first=k, second=7] 9 2 x [2, 4, 6, 8, 10] 2\n");
  });

  it("multiple classes in multiple files", { timeout: T }, async () => {
    const o = await run("java", { "Main.java": JAVA_MAIN, "Student.java": JAVA_STUDENT, "Calculator.java": JAVA_CALCULATOR });
    expectOk(o, "Ada total=252 avg=84.0\n");
  });

  it("packages in a source tree, launched by their package name", { timeout: T }, async () => {
    const files = {
      "src/com/school/App.java": String.raw`package com.school;

import com.school.model.Course;

public class App {
    public static void main(String[] args) {
        Course c = new Course("Algorithms", 4);
        System.out.println(c.describe() + " " + App.class.getName());
    }
}
`,
      "src/com/school/model/Course.java": String.raw`package com.school.model;

public record Course(String title, int credits) {
    public String describe() { return title + " (" + credits + " credits)"; }
}
`,
    };
    expectOk(await run("java", files, { entry: "src/com/school/App.java" }), "Algorithms (4 credits) com.school.App\n");
  });

  it("the selected entry point among several main classes", { timeout: T }, async () => {
    const files = {
      "Main.java": main(`        System.out.println("main");`),
      "Demo.java": `public class Demo {\n    public static void main(String[] args) {\n        System.out.println("demo " + args.length);\n    }\n}\n`,
    };
    expectOk(await run("java", files, { entry: "Demo.java" }), "demo 0\n");
  });

  it("reads a project data file and writes files", { timeout: T }, async () => {
    const code = main(
      String.raw`        List<String> rows = Files.readAllLines(Path.of("data/scores.csv"));
        int sum = 0;
        for (String r : rows) sum += Integer.parseInt(r.split(",")[1]);
        Path out = Path.of("report.txt");
        Files.writeString(out, "sum=" + sum + "\n");
        Path tmp = Files.createTempFile("cw", ".txt");
        Files.write(tmp, rows.subList(1, 3));
        System.out.println(Files.readString(out).trim() + " " + Files.readAllLines(tmp));`,
      "import java.nio.file.*;\nimport java.util.*;\n\n",
    );
    expectOk(await run("java", { "Main.java": code, "data/scores.csv": "ann,90\nbo,85\ncy,77\n" }), "sum=252 [bo,85, cy,77]\n");
  });

  it("large output is streamed completely", { timeout: T }, async () => {
    const o = await run("java", { "Main.java": main(`        for (int i = 0; i < 30000; i++) System.out.println("line " + i);`) });
    expect(o.result.status).toBe("SUCCESS");
    const lines = o.result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(30000);
    expect(lines[29999]).toBe("line 29999");
  });

  it("allocates memory within the limit, and reports heap exhaustion", { timeout: T }, async () => {
    expectOk(await run("java", { "Main.java": main(`        int[] big = new int[8_000_000];\n        big[7_999_999] = 1;\n        System.out.println(big.length);`) }), "8000000\n");
    const o = await run("java", {
      "Main.java": main(`        java.util.List<byte[]> hog = new java.util.ArrayList<>();\n        while (true) hog.add(new byte[1 << 20]);`),
    });
    expect(o.result.status).toBe("RUNTIME_ERROR");
    expect(o.result.stderr).toContain("java.lang.OutOfMemoryError: Java heap space");
    expect(o.result.message).toContain("heap");
  });

  it("an infinite loop is stopped at the time limit", { timeout: T }, async () => {
    const o = await run("java", { "Main.java": main(`        while (true) {}`) });
    expect(o.result.status).toBe("TIME_LIMIT");
    expect(o.result.executionTime).toBeGreaterThanOrEqual(config.limits.timeoutMs);
    await expectCleanedUp(o.result.id);
  });

  it("compilation errors come from javac with file and line", { timeout: T }, async () => {
    const o = await run("java", { "Main.java": "public class Main {\n    public static void main(String[] args) {\n        int x =\n    }\n}\n" });
    expect(o.result.status).toBe("COMPILATION_ERROR");
    // javac reports the incomplete declaration where it finds the closing brace.
    expect(o.result.compileOutput).toMatch(/Main\.java:4: error: illegal start of expression/);
    const sym = await run("java", { "Main.java": main(`        System.out.println(undefinedVar);`) });
    expect(sym.result.compileOutput).toContain("Main.java:3: error: cannot find symbol");
    expect(sym.result.compileOutput).toContain("symbol:   variable undefinedVar");
  });

  it("interactive Scanner input: waits, receives 25, prints 50", { timeout: T }, async () => {
    const code = main(
      String.raw`        java.util.Scanner sc = new java.util.Scanner(System.in);
        System.out.print("n? ");
        System.out.flush();
        int n = sc.nextInt();
        System.out.println(n * 2);
        System.out.print("name? ");
        System.out.flush();
        System.out.println("hi " + sc.next());`,
    );
    const o = await run("java", { "Main.java": code }, { typed: ["25\n", "Ada\n"] });
    expectOk(o, "n? 50\nname? hi Ada\n");
    expect(o.statuses.filter((s) => s === "WAITING_FOR_INPUT")).toHaveLength(2);
    expect(o.stdinEcho).toBe("25\nAda\n");
  });
});

// ================================================================== Python

describe.skipIf(!enabled).concurrent("Python programs", () => {
  it("hello world and input()", { timeout: T }, async () => {
    expectOk(await run("python", { "main.py": 'print("Hello World")\n' }), "Hello World\n");
    const code = 'n = int(input())\nnums = list(map(int, input().split()))\nname = input().strip()\nprint(f"sum={sum(nums[:n])} name={name}")\n';
    expectOk(await run("python", { "main.py": code }, { stdin: "3\n4 5 6\nAda\n" }), "sum=15 name=Ada\n");
  });

  it("loops, functions, closures and decorators", { timeout: T }, async () => {
    const code = String.raw`def greet(name, greeting="Hello", *rest, sep=", ", **extra):
    out = f"{greeting}{sep}{name}"
    if rest:
        out += "|" + ",".join(map(str, rest))
    if extra:
        out += "|" + ",".join(f"{k}={v}" for k, v in sorted(extra.items()))
    return out


def make_counter():
    count = 0

    def inc():
        nonlocal count
        count += 1
        return count

    return inc


def twice(f):
    def wrapper(*a, **kw):
        return f(f(*a, **kw))

    return wrapper


@twice
def add3(x):
    return x + 3


total = 0
for i in range(1, 11):
    if i % 2 == 0:
        continue
    total += i
k = 0
while True:
    k += 1
    if k >= 5:
        break
done = []
for x in [1, 2]:
    pass
else:
    done.append("done")
c = make_counter()
c()
c()
print(total, k, done)
print(greet("Ada"), greet("Bo", "Hi", 1, 2, sep="-", z=1, a=2), c(), add3(1), (lambda a, b: a * b)(6, 7))
`;
    expectOk(await run("python", { "main.py": code }), "25 5 ['done']\nHello, Ada Hi-Bo|1,2|a=2,z=1 3 7 42\n");
  });

  it("recursion", { timeout: T }, async () => {
    const code = String.raw`from functools import lru_cache


@lru_cache(maxsize=None)
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)


def fact(n):
    return 1 if n <= 1 else n * fact(n - 1)


def hanoi(n):
    return 0 if n == 0 else 2 * hanoi(n - 1) + 1


def perms(s):
    return [s] if len(s) <= 1 else [c + p for i, c in enumerate(s) for p in perms(s[:i] + s[i + 1:])]


def deep(n):
    return 0 if n == 0 else n + deep(n - 1)


print(fib(80), fact(20), hanoi(10), len(perms("abcd")), deep(900))
`;
    expectOk(await run("python", { "main.py": code }), "23416728348467685 2432902008176640000 1023 24 405450\n");
  });

  it("lists and dictionaries", { timeout: T }, async () => {
    const code = String.raw`from collections import Counter, defaultdict

nums = [5, 3, 9, 1, 7]
squares = [n * n for n in nums if n > 2]
nums.sort()
nums.append(11)
nums.insert(0, 0)
popped = nums.pop()
matrix = [[i * j for j in range(3)] for i in range(3)]
print(nums, squares, popped, matrix[2], nums[1:4], nums[::-1][:2], sorted(["b", "A", "c"], key=str.lower))

text = "the cat and the hat and the bat"
counts = {}
for w in text.split():
    counts[w] = counts.get(w, 0) + 1
groups = defaultdict(list)
for w in sorted(set(text.split())):
    groups[len(w)].append(w)
inv = {v: k for k, v in {"a": 1, "b": 2}.items()}
print(dict(sorted(counts.items())), Counter(text.split()).most_common(1), dict(groups), inv, counts.get("dog", 0))
`;
    expectOk(
      await run("python", { "main.py": code }),
      "[0, 1, 3, 5, 7, 9] [25, 9, 81, 49] 11 [0, 2, 4] [1, 3, 5] [9, 7] ['A', 'b', 'c']\n" +
        "{'and': 2, 'bat': 1, 'cat': 1, 'hat': 1, 'the': 3} [('the', 3)] {3: ['and', 'bat', 'cat', 'hat', 'the']} {1: 'a', 2: 'b'} 0\n",
    );
  });

  it("classes, inheritance, dataclasses and properties", { timeout: T }, async () => {
    const code = String.raw`from dataclasses import dataclass, field


class Animal:
    count = 0

    def __init__(self, name):
        self.name = name
        Animal.count += 1

    def speak(self):
        return "..."

    def __repr__(self):
        return f"{type(self).__name__}({self.name!r})"


class Dog(Animal):
    def speak(self):
        return "Woof"


class Puppy(Dog):
    def speak(self):
        return super().speak() + "!"


@dataclass(order=True)
class Point:
    x: int
    y: int = 0
    tags: list = field(default_factory=list, compare=False)

    def __add__(self, o):
        return Point(self.x + o.x, self.y + o.y)

    @property
    def norm1(self):
        return abs(self.x) + abs(self.y)


animals = [Animal("a"), Dog("d"), Puppy("p")]
print([a.speak() for a in animals], animals, Animal.count)
print(Point(1, 2) + Point(3), sorted([Point(2), Point(1, 5)]), Point(-3, 4).norm1, isinstance(animals[2], Dog))
`;
    expectOk(
      await run("python", { "main.py": code }),
      "['...', 'Woof', 'Woof!'] [Animal('a'), Dog('d'), Puppy('p')] 3\n" +
        "Point(x=4, y=2, tags=[]) [Point(x=1, y=5, tags=[]), Point(x=2, y=0, tags=[])] 7 True\n",
    );
  });

  it("standard library imports", { timeout: T }, async () => {
    const code = String.raw`import heapq
import itertools
import json
import math
import re
import statistics
from datetime import date

print(math.comb(10, 3), json.dumps({"b": [1, 2], "a": None}, sort_keys=True), list(itertools.accumulate([1, 2, 3, 4])))
print(re.findall(r"\d+", "a1b22c333"), statistics.median([2, 4, 9]), heapq.nsmallest(2, [5, 1, 4, 2]), date(2024, 2, 29).isoformat())
`;
    expectOk(await run("python", { "main.py": code }), '120 {"a": null, "b": [1, 2]} [1, 3, 6, 10]\n' + "['1', '22', '333'] 4 [1, 2] 2024-02-29\n");
  });

  it("multiple modules and a package", { timeout: T }, async () => {
    const files = {
      "main.py": 'import utils\nfrom models import Student\nfrom utils.grading import average, grade\n\ns = Student("Ada", [90, 85, 77])\nprint(s.name, average(s.marks), grade(average(s.marks)), utils.VERSION)\n',
      "models.py": "class Student:\n    def __init__(self, name, marks):\n        self.name = name\n        self.marks = marks\n",
      "utils/__init__.py": 'VERSION = "1.0"\n',
      "utils/grading.py": 'def average(xs):\n    return sum(xs) / len(xs)\n\n\ndef grade(avg):\n    return "A" if avg >= 90 else "B" if avg >= 80 else "C"\n',
    };
    expectOk(await run("python", files, { entry: "main.py" }), "Ada 84.0 B 1.0\n");
  });

  it("caught exceptions, then an uncaught one with a real traceback", { timeout: T }, async () => {
    const code = String.raw`class BankError(Exception):
    pass


def withdraw(balance, amount):
    if amount > balance:
        raise BankError(f"need {amount - balance} more")
    return balance - amount


log = []
try:
    withdraw(10, 25)
except BankError as e:
    log.append(str(e))
finally:
    log.append("finally")
try:
    {}["missing"]
except KeyError as e:
    log.append(f"KeyError {e}")
print(log)
withdraw(1, 2)
`;
    const o = await run("python", { "main.py": code });
    expect(o.result.status).toBe("RUNTIME_ERROR");
    expect(o.result.stdout).toBe(`['need 15 more', 'finally', "KeyError 'missing'"]\n`);
    expect(o.result.stderr).toMatch(/^Traceback \(most recent call last\):/);
    expect(o.result.stderr).toContain('File "/workspace/main.py", line 23, in <module>');
    expect(o.result.stderr).toContain("BankError: need 1 more");
  });

  it("large output, infinite loop and memory exhaustion", { timeout: T }, async () => {
    const big = await run("python", { "main.py": 'for i in range(30000):\n    print(f"line {i}")\n' });
    expect(big.result.stdout.trimEnd().split("\n")).toHaveLength(30000);
    const loop = await run("python", { "main.py": "while True:\n    pass\n" });
    expect(loop.result.status).toBe("TIME_LIMIT");
    const mem = await run("python", { "main.py": "x = [0] * 60_000_000\nprint(len(x))\n" });
    expect(mem.result.status).toBe("MEMORY_LIMIT");
    expect(mem.result.stdout).toBe("");
  });

  it("interactive input(): prompts, waits, and does not count the wait as run time", { timeout: T }, async () => {
    const code = 'name = input("name? ")\nage = int(input("age? "))\nprint(f"{name} will be {age + 1}")\n';
    // The second wait is longer than the whole run-time limit.
    const o = await run("python", { "main.py": code }, { typed: ["Ada\n", "36\n"], typeDelayMs: 6_000 });
    expectOk(o, "name? age? Ada will be 37\n");
    expect(o.statuses.filter((s) => s === "WAITING_FOR_INPUT")).toHaveLength(2);
    expect(o.result.executionTime!).toBeLessThan(config.limits.timeoutMs);
  });

  it("interactive input until end-of-file", { timeout: T }, async () => {
    const o = await run("python", { "main.py": "import sys\ndata = sys.stdin.read()\nprint(len(data.split()))\n" }, { typed: ["a b\n", "c\n", "<EOF>"] });
    expectOk(o, "3\n");
  });
});

// ================================================================== C++ and C

const CPP_FILES: Files = {
  "main.cpp": '#include <iostream>\n#include "calculator.h"\n#include "lib/geometry.h"\n\nint main() {\n    Student ada("Ada", {90, 85, 77});\n    std::cout << ada.name() << " total=" << calc::total(ada) << " avg=" << calc::average(ada) << " area=" << geometry::area(3, 4) << "\\n";\n}\n',
  "student.h": "#pragma once\n#include <string>\n#include <vector>\n\nclass Student {\npublic:\n    Student(std::string name, std::vector<int> marks);\n    const std::string& name() const;\n    const std::vector<int>& marks() const;\n\nprivate:\n    std::string name_;\n    std::vector<int> marks_;\n};\n",
  "student.cpp": '#include "student.h"\n#include <utility>\n\nStudent::Student(std::string n, std::vector<int> m) : name_(std::move(n)), marks_(std::move(m)) {}\nconst std::string& Student::name() const { return name_; }\nconst std::vector<int>& Student::marks() const { return marks_; }\n',
  "calculator.h": '#ifndef CALCULATOR_H\n#define CALCULATOR_H\n#include "student.h"\n\nnamespace calc {\nint total(const Student& s);\ndouble average(const Student& s);\n}\n#endif\n',
  "calculator.cpp": '#include "calculator.h"\n#include <numeric>\n\nnamespace calc {\nint total(const Student& s) { return std::accumulate(s.marks().begin(), s.marks().end(), 0); }\ndouble average(const Student& s) { return static_cast<double>(total(s)) / s.marks().size(); }\n}\n',
  "lib/geometry.h": "#pragma once\nnamespace geometry {\nint area(int w, int h);\n}\n",
  "lib/geometry.cpp": '#include "geometry.h"\n\nnamespace geometry {\nint area(int w, int h) { return w * h; }\n}\n',
};

describe.skipIf(!enabled).concurrent("C++ and C programs", () => {
  it("hello world and cin", { timeout: T }, async () => {
    expectOk(await run("cpp", { "main.cpp": '#include <iostream>\nint main() { std::cout << "Hello World" << std::endl; }\n' }), "Hello World\n");
    const code = String.raw`#include <iostream>
#include <numeric>
#include <string>
#include <vector>
using namespace std;

int main() {
    int n;
    cin >> n;
    vector<long long> v(n);
    for (auto& x : v) cin >> x;
    string name;
    cin >> name;
    cout << "sum=" << accumulate(v.begin(), v.end(), 0LL) << " name=" << name << "\n";
}
`;
    expectOk(await run("cpp", { "main.cpp": code }, { stdin: "3\n1 2 3\nAda\n" }), "sum=6 name=Ada\n");
  });

  it("loops, arrays and the STL", { timeout: T }, async () => {
    const code = String.raw`#include <algorithm>
#include <iostream>
#include <map>
#include <queue>
#include <set>
#include <stack>
#include <string>
#include <unordered_map>
#include <vector>
using namespace std;

int main() {
    int total = 0;
    for (int i = 1; i <= 10; i++) { if (i % 2 == 0) continue; total += i; }
    int k = 0;
    while (k < 5) k++;
    do { k--; } while (k > 2);
    int a[] = {5, 3, 9, 1, 7};
    sort(a, a + 5);
    int m[3][4];
    int s = 0;
    for (int i = 0; i < 3; i++) for (int j = 0; j < 4; j++) { m[i][j] = i * j; s += m[i][j]; }
    cout << total << " " << k << " " << a[0] << a[4] << " " << s << " " << sizeof(a) / sizeof(a[0]) << "\n";

    vector<int> v{5, 3, 9, 1, 7};
    sort(v.rbegin(), v.rend());
    map<string, int> words;
    for (string w : {"b", "a", "b"}) words[w]++;
    set<int> uniq(v.begin(), v.end());
    unordered_map<int, int> um{{1, 2}};
    queue<int> q;
    q.push(1);
    q.push(2);
    stack<int> st;
    st.push(3);
    priority_queue<int> pq(v.begin(), v.end());
    auto it = find(v.begin(), v.end(), 9);
    cout << v[0] << v[4] << " " << words["a"] << words["b"] << " " << uniq.size() << " " << um[1] << " " << q.front() << st.top() << " " << pq.top() << " " << (it - v.begin()) << "\n";
}
`;
    expectOk(await run("cpp", { "main.cpp": code }), "25 2 19 18 5\n91 12 5 2 13 9 0\n");
  });

  it("functions, templates, lambdas, classes and virtual dispatch", { timeout: T }, async () => {
    const code = String.raw`#include <iostream>
#include <memory>
#include <string>
#include <vector>
using namespace std;

int add(int a, int b) { return a + b; }
double add(double a, double b) { return a + b; }
template <typename T> T biggest(T a, T b) { return a > b ? a : b; }
void bump(int& x, int y = 10) { x += y; }

class Shape {
public:
    virtual ~Shape() = default;
    virtual double area() const = 0;
    virtual string name() const { return "shape"; }
};
class Rect : public Shape {
protected:
    double w, h;
public:
    Rect(double w, double h) : w(w), h(h) {}
    double area() const override { return w * h; }
    string name() const override { return "rect"; }
};
class Square : public Rect {
public:
    explicit Square(double s) : Rect(s, s) {}
    string name() const override { return "square"; }
};
struct Vec {
    int x, y;
    Vec operator+(const Vec& o) const { return {x + o.x, y + o.y}; }
};
struct Tracker {
    static int alive;
    Tracker() { ++alive; }
    ~Tracker() { --alive; }
};
int Tracker::alive = 0;

int main() {
    int x = 1;
    bump(x);
    bump(x, 5);
    auto sq = [](int n) { return n * n; };
    int factor = 3;
    auto times = [factor](int n) { return n * factor; };
    cout << add(2, 3) << " " << add(1.5, 2.25) << " " << biggest<string>("pear", "apple") << " " << x << " " << sq(9) << " " << times(7) << "\n";

    vector<unique_ptr<Shape>> shapes;
    shapes.push_back(make_unique<Rect>(2, 3));
    shapes.push_back(make_unique<Square>(4));
    double total = 0;
    string names;
    for (auto& s : shapes) { total += s->area(); names += s->name() + ","; }
    Vec v = Vec{1, 2} + Vec{3, 4};
    { Tracker a, b; }
    Tracker c;
    cout << names << " " << total << " " << v.x << "," << v.y << " " << Tracker::alive << "\n";
}
`;
    expectOk(await run("cpp", { "main.cpp": code }), "5 3.75 pear 16 81 21\nrect,square, 22 4,6 1\n");
  });

  it("multiple source files and headers, including a subfolder", { timeout: T }, async () => {
    expectOk(await run("cpp", CPP_FILES, { entry: "main.cpp" }), "Ada total=252 avg=84 area=12\n");
  });

  it("compilation errors come from g++", { timeout: T }, async () => {
    const o = await run("cpp", { "main.cpp": "#include <iostream>\nint main() {\n    int x = 5\n    std::cout << y << std::endl;\n}\n" });
    expect(o.result.status).toBe("COMPILATION_ERROR");
    // GCC's own wording, including its typographic quotes.
    expect(o.result.compileOutput).toContain("main.cpp:4:5: error: expected ‘,’ or ‘;’ before ‘std’");
    const undeclared = await run("cpp", { "main.cpp": "#include <iostream>\nint main() {\n    std::cout << y << std::endl;\n}\n" });
    expect(undeclared.result.compileOutput).toContain("main.cpp:3:18: error: ‘y’ was not declared in this scope");
  });

  it("runtime errors: segfault, uncaught exception and integer division by zero", { timeout: T }, async () => {
    const seg = await run("cpp", { "main.cpp": '#include <iostream>\nint main() {\n    int* p = nullptr;\n    std::cout << "before" << std::endl;\n    *p = 1;\n}\n' });
    expect(seg.result.status).toBe("RUNTIME_ERROR");
    expect(seg.result.exitCode).toBe(139);
    expect(seg.result.stdout).toBe("before\n");
    expect(seg.result.message).toContain("SIGSEGV");
    const ex = await run("cpp", { "main.cpp": '#include <stdexcept>\nint main() {\n    throw std::runtime_error("boom");\n}\n' });
    expect(ex.result.exitCode).toBe(134);
    expect(ex.result.stderr).toContain("terminate called after throwing an instance of 'std::runtime_error'");
    expect(ex.result.stderr).toContain("what():  boom");
    expect(ex.result.message).toContain("SIGABRT");
    // (GCC rewrites 1 / z as a comparison, so divide a non-constant numerator.)
    const fpe = await run("cpp", { "main.cpp": "#include <iostream>\nint main() {\n    volatile int n = 7, z = 0;\n    std::cout << n / z;\n}\n" });
    // Integer division by zero is undefined behaviour; the hardware decides. x86 traps
    // (SIGFPE); Arm64's sdiv returns 0 and the program continues.
    if (process.arch === "arm64") {
      expect(fpe.result.status).toBe("SUCCESS");
      expect(fpe.result.stdout).toBe("0");
    } else {
      expect(fpe.result.exitCode).toBe(136);
      expect(fpe.result.message).toContain("SIGFPE");
    }
  });

  it("an infinite loop is stopped", { timeout: T }, async () => {
    const o = await run("cpp", { "main.cpp": "int main() {\n    volatile long i = 0;\n    while (true) { i++; }\n}\n" });
    expect(o.result.status).toBe("TIME_LIMIT");
  });

  it("interactive cin", { timeout: T }, async () => {
    const code = '#include <iostream>\nint main() {\n    int a, b;\n    std::cout << "a? " << std::flush;\n    std::cin >> a;\n    std::cout << "b? " << std::flush;\n    std::cin >> b;\n    std::cout << a + b << std::endl;\n}\n';
    const o = await run("cpp", { "main.cpp": code }, { typed: ["20\n", "22\n"] });
    expectOk(o, "a? b? 42\n");
    expect(o.statuses.filter((s) => s === "WAITING_FOR_INPUT")).toHaveLength(2);
  });

  it("C: scanf and multiple files", { timeout: T }, async () => {
    const files = {
      "main.c": '#include <stdio.h>\n#include "stats.h"\n\nint main(void) {\n    int n, xs[16];\n    scanf("%d", &n);\n    for (int i = 0; i < n; i++) scanf("%d", &xs[i]);\n    printf("max=%d mean=%.2f\\n", max_of(xs, n), mean_of(xs, n));\n    return 0;\n}\n',
      "stats.h": "#ifndef STATS_H\n#define STATS_H\nint max_of(const int* xs, int n);\ndouble mean_of(const int* xs, int n);\n#endif\n",
      "stats.c": '#include "stats.h"\n\nint max_of(const int* xs, int n) {\n    int m = xs[0];\n    for (int i = 1; i < n; i++) if (xs[i] > m) m = xs[i];\n    return m;\n}\n\ndouble mean_of(const int* xs, int n) {\n    double s = 0;\n    for (int i = 0; i < n; i++) s += xs[i];\n    return s / n;\n}\n',
    };
    expectOk(await run("c", files, { entry: "main.c", stdin: "4\n3 9 4 1\n" }), "max=9 mean=4.25\n");
  });
});

// ================================================================== JavaScript and TypeScript

describe.skipIf(!enabled).concurrent("JavaScript and TypeScript programs", () => {
  it("classes, private fields, closures, collections, generators and async/await", { timeout: T }, async () => {
    const code = String.raw`class Account {
  #balance = 0;
  constructor(owner) { this.owner = owner; }
  deposit(n) {
    if (n <= 0) throw new RangeError("amount must be positive");
    this.#balance += n;
    return this;
  }
  get balance() { return this.#balance; }
}
const acc = new Account("Ada").deposit(50).deposit(25);
const { owner, balance } = acc;
const counter = (() => { let c = 0; return () => ++c; })();
counter();
counter();
const words = ["b", "a", "c", "a"];
const uniq = [...new Set(words)].sort();
const freq = words.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map());
function* range(n) { for (let i = 0; i < n; i++) yield i; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  await sleep(10);
  let err = "";
  try { acc.deposit(-1); } catch (e) { err = e.name + ": " + e.message; }
  console.log(owner, balance, counter(), uniq.join(""), freq.get("a"), [...range(4)].map((x) => x * x).join(","), JSON.stringify({ z: 1, a: [true, null] }), err);
}
main();
`;
    expectOk(await run("javascript", { "main.js": code }), 'Ada 75 3 abc 2 0,1,4,9 {"z":1,"a":[true,null]} RangeError: amount must be positive\n');
  });

  it("CommonJS and ES modules across files, and stdin", { timeout: T }, async () => {
    const cjs = { "main.js": 'const { total } = require("./lib/math.js");\nconsole.log(total([1, 2, 3]));\n', "lib/math.js": "module.exports = { total: (xs) => xs.reduce((a, b) => a + b, 0) };\n" };
    expectOk(await run("javascript", cjs), "6\n");
    const esm = { "main.mjs": 'import { hi } from "./greet.mjs";\nconsole.log(hi("Bo"));\n', "greet.mjs": 'export const hi = (n) => "hi " + n;\n' };
    expectOk(await run("javascript", esm, { entry: "main.mjs" }), "hi Bo\n");
    const stdin = await run("javascript", { "main.js": 'const xs = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconsole.log(xs.reduce((a, b) => a + b, 0));\n' }, { stdin: "1 2 3 4\n" });
    expectOk(stdin, "10\n");
  });

  it("a runtime TypeError is reported with its stack", { timeout: T }, async () => {
    const o = await run("javascript", { "main.js": 'console.log("start");\nconst user = null;\nconsole.log(user.name);\n' });
    expect(o.result.status).toBe("RUNTIME_ERROR");
    expect(o.result.stdout).toBe("start\n");
    expect(o.result.stderr).toContain("TypeError: Cannot read properties of null (reading 'name')");
    expect(o.result.stderr).toContain("/workspace/main.js:3");
  });

  it("interactive readline input (event loop waiting on stdin)", { timeout: T }, async () => {
    const code = String.raw`const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const it = rl[Symbol.asyncIterator]();
(async () => {
  process.stdout.write("x? ");
  const x = Number((await it.next()).value);
  process.stdout.write("y? ");
  const y = Number((await it.next()).value);
  console.log(x * y);
  rl.close();
})();
`;
    const o = await run("javascript", { "main.js": code }, { typed: ["6\n", "7\n"] });
    expectOk(o, "x? y? 42\n");
    expect(o.statuses).toContain("WAITING_FOR_INPUT");
  });

  it("TypeScript: enums, interfaces, parameter properties, generics and unions", { timeout: T }, async () => {
    const code = String.raw`enum Color { Red = "RED", Green = "GREEN" }

interface Shape {
  area(): number;
  readonly kind: string;
}

class Circle implements Shape {
  readonly kind = "circle";
  constructor(private readonly r: number) {}
  area(): number {
    return Math.round(Math.PI * this.r ** 2 * 100) / 100;
  }
}

function first<T>(xs: T[]): T | undefined {
  return xs[0];
}

type Result = { ok: true; value: number } | { ok: false; error: string };

function parse(s: string): Result {
  const n = Number(s);
  return Number.isNaN(n) ? { ok: false, error: "bad: " + s } : { ok: true, value: n };
}

const results = ["4", "x"].map(parse).map((r) => (r.ok ? r.value * 2 : r.error));
console.log(Color.Green, new Circle(2).area(), first(["a", "b"]), results.join(" "), first<number>([]) ?? "none");
`;
    expectOk(await run("typescript", { "main.ts": code }), "GREEN 12.57 a 8 bad: x none\n");
  });

  it("TypeScript: modules across files", { timeout: T }, async () => {
    const files = {
      "main.ts": 'import { total, type Item } from "./cart.ts";\n\nconst items: Item[] = [{ name: "pen", price: 2 }, { name: "book", price: 12 }];\nconsole.log(total(items));\n',
      "cart.ts": "export interface Item {\n  name: string;\n  price: number;\n}\n\nexport function total(items: Item[]): number {\n  return items.reduce((s, i) => s + i.price, 0);\n}\n",
    };
    expectOk(await run("typescript", files, { entry: "main.ts" }), "14\n");
  });
});

// ================================================================== Adversarial programs

describe.skipIf(!enabled).concurrent("Adversarial programs are contained", () => {
  it("runs as an unprivileged user with no capabilities, read-only system files and no network", { timeout: T }, async () => {
    const code = String.raw`import os, socket

status = dict(line.split(":\t", 1) for line in open("/proc/self/status").read().splitlines() if ":\t" in line)
print(os.getuid(), os.getcwd(), status["CapEff"].strip(), status["NoNewPrivs"].strip())
for path in ("/etc/passwd", "/usr/cw-test", "/workspace/ok.txt"):
    try:
        with open(path, "a") as f:
            f.write("x")
        print(path, "writable")
    except OSError as e:
        print(path, type(e).__name__)
try:
    socket.create_connection(("1.1.1.1", 53), timeout=3)
    print("network open")
except OSError as e:
    print("network", type(e).__name__)
try:
    socket.getaddrinfo("example.com", 80)
    print("dns open")
except OSError as e:
    print("dns", type(e).__name__)
`;
    expectOk(
      await run("python", { "main.py": code }),
      "65534 /workspace 0000000000000000 1\n/etc/passwd PermissionError\n/usr/cw-test OSError\n/workspace/ok.txt writable\nnetwork OSError\ndns gaierror\n",
    );
  });

  it("a network failure is explained", { timeout: T }, async () => {
    const o = await run("python", { "main.py": 'import urllib.request\nurllib.request.urlopen("http://example.com", timeout=3)\n' });
    expect(o.result.status).toBe("RUNTIME_ERROR");
    expect(o.result.message).toBe("Network access is disabled in the sandbox.");
  });

  it("a fork bomb is contained by the process limit and stopped", { timeout: T }, async () => {
    const o = await run("python", { "main.py": "import os\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        pass\n" });
    expect(o.result.status).toBe("TIME_LIMIT");
    await expectCleanedUp(o.result.id);
  });

  it("rapid child-process creation works within limits", { timeout: T }, async () => {
    const code = 'import subprocess\nouts = [subprocess.run(["echo", str(i)], capture_output=True, text=True).stdout.strip() for i in range(200)]\nprint(len(outs), outs[-1])\n';
    expectOk(await run("python", { "main.py": code }), "200 199\n");
  });

  it("an output flood is cut off", { timeout: T }, async () => {
    const o = await run("python", { "main.py": 'while True:\n    print("x" * 1000)\n' });
    expect(o.result.status).toBe("OUTPUT_LIMIT");
    expect(o.result.stdout.length).toBeLessThanOrEqual(config.limits.maxOutputBytes);
  });

  it("oversized files and a full disk are refused and explained", { timeout: T }, async () => {
    const big = await run("python", { "main.py": 'with open("big.bin", "wb") as f:\n    f.write(b"0" * (20 * 1024 * 1024))\n' });
    expect(big.result.status).toBe("RUNTIME_ERROR");
    expect(big.result.stderr).toContain("File too large");
    expect(big.result.message).toBe("Files written by the program are limited to 16 MB.");
    const full = await run("python", { "main.py": 'for i in range(6):\n    with open(f"f{i}.bin", "wb") as f:\n        f.write(b"0" * (15 * 1024 * 1024))\n' });
    expect(full.result.status === "RUNTIME_ERROR" || full.result.status === "MEMORY_LIMIT").toBe(true);
    if (full.result.status === "RUNTIME_ERROR") expect(full.result.message).toBe("The sandbox's writable space (64 MB) is full.");
  });

  it("a long sleep is stopped at the time limit", { timeout: T }, async () => {
    const o = await run("python", { "main.py": "import time\ntime.sleep(60)\n" });
    expect(o.result.status).toBe("TIME_LIMIT");
  });

  it("cancellation stops a running program and removes its sandbox", { timeout: T }, async () => {
    const o = await run("python", { "main.py": 'i = 0\nwhile True:\n    i += 1\n' }, { cancelAfterMs: 2500 });
    expect(o.result.status).toBe("CANCELLED");
    expect(o.result.executionTime!).toBeLessThan(6000);
    await expectCleanedUp(o.result.id);
  });

  it("cancellation also stops a program waiting for input", { timeout: T }, async () => {
    const o = await run("java", { "Main.java": main(`        new java.util.Scanner(System.in).nextLine();`) }, { typed: [], cancelAfterMs: 8000 });
    expect(o.statuses).toContain("WAITING_FOR_INPUT");
    expect(o.result.status).toBe("CANCELLED");
    await expectCleanedUp(o.result.id);
  });
});

// ================================================================== Test mode

describe.skipIf(!enabled).concurrent("Test mode", () => {
  it("compiles once and runs every input; a slow or crashing test does not stop the others", { timeout: T }, async () => {
    const code = main(
      `        java.util.Scanner in = new java.util.Scanner(System.in);
        int n = in.nextInt();
        if (n < 0) while (true) {}
        System.out.println(10 / n);`,
    );
    const o = await run("java", { "Main.java": code }, { tests: ["2", "-1", "0", "5\n"] });
    expect(o.result.status).toBe("SUCCESS");
    expect(o.statuses.filter((s) => s === "COMPILING")).toHaveLength(1);
    const tests = o.result.tests!;
    expect(tests.map((t) => t.status)).toEqual(["SUCCESS", "TIME_LIMIT", "RUNTIME_ERROR", "SUCCESS"]);
    expect(tests[0]!.stdout).toBe("5\n");
    expect(tests[1]!.executionTime).toBeLessThanOrEqual(config.limits.timeoutMs);
    expect(tests[2]!.stderr).toContain("ArithmeticException");
    expect(tests[3]!.stdout).toBe("2\n");
    await expectCleanedUp(o.result.id);
  });

  it("keeps the first 64 KB of a flood and still runs the next test", { timeout: T }, async () => {
    const o = await run("python", { "main.py": 'n = int(input())\nfor i in range(n): print("x" * 100)\nprint("done")\n' }, { tests: ["100000", "1"] });
    expect(o.result.tests!.map((t) => t.status)).toEqual(["SUCCESS", "SUCCESS"]);
    expect(o.result.tests![0]!.stdout.length).toBeLessThanOrEqual(64 * 1024);
    expect(o.result.tests![0]!.message).toContain("64 KB");
    expect(o.result.tests![1]!.stdout).toBe("x".repeat(100) + "\ndone\n");
  });

  it("stops at a compilation error without running tests", { timeout: T }, async () => {
    const o = await run("cpp", { "main.cpp": "int main() { return x; }\n" }, { tests: ["1"] });
    expect(o.result.status).toBe("COMPILATION_ERROR");
    expect(o.result.tests).toBeUndefined();
  });
});
