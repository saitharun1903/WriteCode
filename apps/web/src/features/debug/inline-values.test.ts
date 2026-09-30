import { describe, expect, it } from "vitest";
import { inlineValues, previewOf, shortValue } from "./inline-values";

const JAVA = `public class Main {
    static int factorial(int n) {
        if (n <= 1) return 1;
        return n * factorial(n - 1);
    }

    public static void main(String[] args) {
        int[] nums = {5, 2, 9};
        int total = 0;
        for (int i = 0; i < nums.length; i++) {
            total += nums[i];
        }
    }
}`.split("\n");

const v = (name: string, value: string, changed = false) => ({ name, value, changed });

describe("inlineValues", () => {
  it("puts each variable on the last line at or above the paused line that uses it", () => {
    const out = inlineValues(JAVA, 11, [v("args", "String[0]"), v("nums", "[5, 2, 9]"), v("total", "5", true), v("i", "1", true)]);
    expect(out).toEqual(
      new Map([
        [11, [v("nums", "[5, 2, 9]"), v("total", "5", true), v("i", "1", true)]],
        [7, [v("args", "String[0]")]],
      ]),
    );
  });

  it("stays inside the current function", () => {
    // Paused in factorial: `n` must not be matched in main below or other methods above.
    const out = inlineValues(JAVA, 3, [v("n", "4")]);
    expect([...out.entries()]).toEqual([[3, [v("n", "4")]]]);
  });

  it("works for Python and ignores comments and attribute names", () => {
    const py = ["def area(w, h):", "    # w is width", "    self.w = 3", "    result = w * h", "    return result"];
    const out = inlineValues(py, 5, [v("w", "2"), v("result", "6")]);
    expect(out).toEqual(
      new Map([
        [5, [v("result", "6")]],
        [4, [v("w", "2")]],
      ]),
    );
  });

  it("stays inside a TypeScript method", () => {
    const lines = ["const x = 1;", "class Stack<T> {", "  push(x: T): void {", "    this.items.push(x);", "  }", "}"];
    const at = inlineValues(lines, 4, [{ name: "x", value: "7", changed: false }]);
    expect([...at.keys()]).toEqual([4]);
    expect(inlineValues(["if (a) {", "  b = 1;"], 2, [{ name: "a", value: "true", changed: false }]).get(1)).toBeDefined();
  });

  it("shortens long values", () => {
    expect(shortValue("x".repeat(50), 10)).toBe("xxxxxxxxx…");
  });
});

describe("previewOf", () => {
  it("previews arrays as lists and other containers as fields", () => {
    expect(previewOf([{ name: "[0]", value: "5" }, { name: "[1]", value: "2" }])).toBe("[5, 2]");
    expect(previewOf([{ name: "ann", value: "30" }])).toBe("{ann: 30}");
    expect(previewOf([])).toBeNull();
    expect(previewOf([{ name: "[0]", value: '"ann"' }, { name: "elementData", value: "Object[10]" }, { name: "size", value: "1" }])).toBe('["ann"]');
    expect(previewOf(Array.from({ length: 10 }, (_, i) => ({ name: `[${i}]`, value: String(i) })), 3)).toBe("[0, 1, 2, …]");
  });
});
