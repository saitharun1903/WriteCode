#!/usr/bin/env node
// Smoke and security test of a deployed Code Workspace through its public URL:
// real programs and hostile programs go through HTTPS -> API -> queue -> worker
// -> sandbox, and results come back over the WebSocket, as for a browser.
//
//   node deploy/smoke.mjs https://writecode.in
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node deploy/smoke.mjs https://localhost   (local staging CA)
//
// Runs sequentially to stay within the per-client rate limits.

const base = (process.argv[2] ?? "https://writecode.in").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");

async function execute(language, files, { entry, stdin } = {}) {
  const started = performance.now();
  const res = await fetch(`${base}/api/v1/executions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language, files: Object.entries(files).map(([path, content]) => ({ path, content })), entry: entry ?? Object.keys(files)[0], stdin }),
  });
  if (!res.ok) throw new Error(`POST ${res.status}: ${await res.text()}`);
  const { id } = await res.json();
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    const timer = setTimeout(() => (ws.close(), reject(new Error("no result within 90s"))), 90_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", executionId: id }));
    ws.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "result") {
        clearTimeout(timer);
        ws.close();
        resolve(e.result);
      }
    };
    ws.onerror = () => (clearTimeout(timer), reject(new Error("websocket error")));
  });
  return { ...result, wallMs: Math.round(performance.now() - started) };
}

const cases = [
  ["java", "Java multi-file", { "Main.java": 'public class Main {\n  public static void main(String[] a) {\n    System.out.println(new Calc().add(20, 22));\n  }\n}\n', "Calc.java": "public class Calc {\n  int add(int a, int b) { return a + b; }\n}\n" }, {}, (r) => r.status === "SUCCESS" && r.stdout === "42\n"],
  ["java", "Java stdin", { "Main.java": 'import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    System.out.println(new Scanner(System.in).nextInt() * 2);\n  }\n}\n' }, { stdin: "25\n" }, (r) => r.stdout === "50\n"],
  ["java", "Java compile error", { "Main.java": "public class Main {\n  public static void main(String[] a) {\n    int x =\n  }\n}\n" }, {}, (r) => r.status === "COMPILATION_ERROR" && /Main\.java:4: error/.test(r.compileOutput)],
  ["java", "Java runtime exception", { "Main.java": "public class Main {\n  public static void main(String[] a) {\n    int x = 10 / 0;\n  }\n}\n" }, {}, (r) => r.status === "RUNTIME_ERROR" && r.stderr.includes("ArithmeticException")],
  ["python", "Python modules", { "main.py": "from util import sq\nprint(sq(7))\n", "util.py": "def sq(x):\n    return x * x\n" }, {}, (r) => r.stdout === "49\n"],
  ["cpp", "C++ multi-file + STL", { "main.cpp": '#include <iostream>\n#include <vector>\n#include "lib.h"\nint main() { std::vector<int> v{1,2,3}; std::cout << sum(v) << "\\n"; }\n', "lib.h": "#pragma once\n#include <vector>\nint sum(const std::vector<int>& v);\n", "lib.cpp": '#include "lib.h"\nint sum(const std::vector<int>& v) { int s = 0; for (int x : v) s += x; return s; }\n' }, { entry: "main.cpp" }, (r) => r.stdout === "6\n"],
  ["c", "C scanf", { "main.c": '#include <stdio.h>\nint main(void) { int a, b; scanf("%d %d", &a, &b); printf("%d\\n", a * b); }\n' }, { stdin: "6 7\n" }, (r) => r.stdout === "42\n"],
  ["javascript", "JavaScript", { "main.js": "const xs = [3, 1, 2].sort((a, b) => a - b);\nconsole.log(xs.join(','));\n" }, {}, (r) => r.stdout === "1,2,3\n"],
  ["typescript", "TypeScript enum", { "main.ts": 'enum C { A = "a" }\nconst x: number = 2;\nconsole.log(C.A, x * 21);\n' }, {}, (r) => r.stdout === "a 42\n"],
  ["java", "SECURITY infinite loop", { "Main.java": "public class Main {\n  public static void main(String[] a) {\n    while (true) {}\n  }\n}\n" }, {}, (r) => r.status === "TIME_LIMIT"],
  ["python", "SECURITY fork bomb", { "main.py": "import os\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        pass\n" }, {}, (r) => r.status === "TIME_LIMIT"],
  ["python", "SECURITY memory exhaustion", { "main.py": "x = [0] * 60_000_000\n" }, {}, (r) => r.status === "MEMORY_LIMIT"],
  ["python", "SECURITY output flood", { "main.py": 'while True:\n    print("x" * 1000)\n' }, {}, (r) => r.status === "OUTPUT_LIMIT"],
  ["python", "SECURITY disk filling", { "main.py": 'for i in range(6):\n    open(f"f{i}", "wb").write(b"0" * (15 << 20))\n' }, {}, (r) => r.status === "RUNTIME_ERROR" || r.status === "MEMORY_LIMIT"],
  ["python", "SECURITY large file", { "main.py": 'open("big", "wb").write(b"0" * (20 << 20))\n' }, {}, (r) => r.status === "RUNTIME_ERROR" && r.stderr.includes("File too large")],
  ["python", "SECURITY system file write", { "main.py": 'open("/etc/passwd", "a").write("x")\n' }, {}, (r) => r.status === "RUNTIME_ERROR" && r.stderr.includes("PermissionError")],
  ["python", "SECURITY network connection", { "main.py": 'import socket\nsocket.create_connection(("1.1.1.1", 80), timeout=3)\n' }, {}, (r) => r.status === "RUNTIME_ERROR" && /unreachable|OSError/.test(r.stderr)],
  ["python", "SECURITY child processes", { "main.py": 'import subprocess\nprint(subprocess.run(["id", "-u"], capture_output=True, text=True).stdout.strip())\n' }, {}, (r) => r.stdout === "65534\n"],
];

let failed = 0;
for (const [language, name, files, opts, check] of cases) {
  try {
    const r = await execute(language, files, opts);
    const ok = check(r);
    if (!ok) failed++;
    const t = [r.queueTime !== undefined && `queue ${r.queueTime}ms`, r.startupTime !== undefined && `sandbox ${r.startupTime}ms`, r.compileTime !== undefined && `compile ${r.compileTime}ms`, r.executionTime !== undefined && `run ${r.executionTime}ms`, `total ${r.wallMs}ms`].filter(Boolean).join(", ");
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${r.status.padEnd(17)} ${t}${r.message ? `  [${r.message}]` : ""}`);
    if (!ok) console.log(`      stdout=${JSON.stringify(r.stdout.slice(0, 200))} stderr=${JSON.stringify(r.stderr.slice(-300))}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name.padEnd(30)} ${e.message}`);
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);
