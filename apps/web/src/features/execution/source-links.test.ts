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
});
