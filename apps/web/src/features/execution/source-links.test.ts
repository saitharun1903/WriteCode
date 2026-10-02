import { describe, expect, it } from "vitest";
import { linkSources, resolveFile } from "./source-links";

const links = (text: string, files: string[]) => linkSources(text, files).filter((s) => "file" in s);

describe("linking output to source", () => {
  it("links Java compiler errors and stack frames in the project, not library frames", () => {
    const files = ["Main.java", "util/Calc.java"];
    expect(links("Main.java:3: error: ';' expected", files)).toEqual([{ text: "Main.java:3", file: "Main.java", line: 3 }]);
    const trace = `Exception in thread "main" java.lang.NumberFormatException: For input string: "x"
\tat java.base/java.lang.Integer.parseInt(Integer.java:614)
\tat util.Calc.parse(Calc.java:7)
\tat Main.main(Main.java:5)`;
    expect(links(trace, files)).toEqual([
      { text: "Calc.java:7", file: "util/Calc.java", line: 7 },
      { text: "Main.java:5", file: "Main.java", line: 5 },
    ]);
  });

  it("links Python tracebacks, g++ errors and Node stack frames, with columns", () => {
    expect(links('  File "/workspace/main.py", line 3, in <module>', ["main.py"])).toEqual([{ text: 'File "/workspace/main.py", line 3', file: "main.py", line: 3 }]);
    expect(links("main.cpp:5:10: error: expected ';'", ["main.cpp"])).toEqual([{ text: "main.cpp:5:10", file: "main.cpp", line: 5, column: 10 }]);
    expect(links("    at add (/workspace/lib/math.js:3:5)", ["main.js", "lib/math.js"])).toEqual([{ text: "/workspace/lib/math.js:3:5", file: "lib/math.js", line: 3, column: 5 }]);
  });

  it("keeps all the text, in order, and never guesses between same-named files", () => {
    const text = "at A.run(A.java:2) and B.java:4";
    expect(linkSources(text, ["A.java", "B.java"]).map((s) => s.text).join("")).toBe(text);
    expect(resolveFile("Util.java", ["a/Util.java", "b/Util.java"])).toBeNull();
    expect(resolveFile("b/Util.java", ["a/Util.java", "b/Util.java"])).toBe("b/Util.java");
    expect(links("see version 1.2:3", ["Main.java"])).toEqual([]);
  });

  it("links the places the later languages name: Go, Rust, C#, PHP, Ruby, SQL and Bash", () => {
    const at = (text: string, files: string[]) => linkSources(text, files).flatMap((seg) => ("file" in seg ? [`${seg.file}:${seg.line}${seg.column ? `:${seg.column}` : ""}`] : []));
    expect(at("./main.go:7:14: undefined: y\n\t/workspace/main.go:8 +0x17", ["main.go"])).toEqual(["main.go:7:14", "main.go:8"]);
    expect(at(" --> main.rs:1:26\nthread 'main' panicked at main.rs:4:20:", ["main.rs"])).toEqual(["main.rs:1:26", "main.rs:4:20"]);
    expect(at("Program.cs(5,13): error CS0029: no\n   at Program.Main() in /workspace/Program.cs:line 9", ["Program.cs"])).toEqual(["Program.cs:5:13", "Program.cs:9"]);
    expect(at("Parse error: unexpected in /workspace/main.php on line 3\n#0 /workspace/main.php(5): f()\nUncaught Exception: boom in /workspace/main.php:2", ["main.php"])).toEqual(["main.php:3", "main.php:5", "main.php:2"]);
    expect(at("main.rb:2:in 'Object#f': boom (RuntimeError)", ["main.rb"])).toEqual(["main.rb:2"]);
    expect(at("main.sql:3: error: no such table: missing", ["main.sql"])).toEqual(["main.sql:3"]);
    expect(at("main.sh: line 2: nosuchcommand: command not found", ["main.sh"])).toEqual(["main.sh:2"]);
    // A file that is not in the project stays plain text.
    expect(at("/usr/lib/ruby/3.4.0/set.rb:12:in 'x'", ["main.rb"])).toEqual([]);
  });
});
