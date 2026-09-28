import { describe, expect, it } from "vitest";
import { readsInput } from "./reads-input.js";

const f = (path: string, content: string) => [{ path, content }];

describe("readsInput", () => {
  it("sees a Java program with hard-coded values as not reading input", () => {
    const candies = `public class Candies {
    public static void main(String[] args) {
        int arr[] = {3,4,6,7,9,12,16,17};
        int n = 5; // new Scanner(System.in) would read it
        System.out.println(n);
    }
}`;
    expect(readsInput("java", f("Candies.java", candies))).toBe(false);
    expect(readsInput("java", f("Main.java", "Scanner in = new Scanner(System.in);"))).toBe(true);
    expect(readsInput("java", f("Main.java", "var r = new BufferedReader(new InputStreamReader(System.in));"))).toBe(true);
  });

  it("recognises each language's input functions and ignores comments", () => {
    expect(readsInput("python", f("main.py", "n = int(input())"))).toBe(true);
    expect(readsInput("python", f("main.py", "# n = int(input())\nprint(5)"))).toBe(false);
    expect(readsInput("python", f("main.py", "import sys\ndata = sys.stdin.read()"))).toBe(true);
    expect(readsInput("cpp", f("main.cpp", "int n; std::cin >> n;"))).toBe(true);
    expect(readsInput("cpp", f("main.cpp", "/* cin >> n; */ int main() {}"))).toBe(false);
    expect(readsInput("c", f("main.c", 'scanf("%d", &n);'))).toBe(true);
    expect(readsInput("javascript", f("main.js", 'require("fs").readFileSync(0, "utf8")'))).toBe(true);
    expect(readsInput("typescript", f("main.ts", "console.log(1)"))).toBe(false);
  });

  it("checks every source file, not only the entry", () => {
    expect(readsInput("java", [{ path: "Main.java", content: "Io.read();" }, { path: "Io.java", content: "new Scanner(System.in)" }])).toBe(true);
  });
});
