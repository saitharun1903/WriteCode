import { describe, expect, it } from "vitest";
import { plainMath } from "./plain-math";

describe("plain math in answers", () => {
  it("turns LaTeX from the answer into plain symbols", () => {
    expect(plainMath("reads `5` $\\rightarrow$ array size is 5")).toBe("reads `5` → array size is 5");
    expect(plainMath("| 1 | $4 > 3 \\rightarrow$ low = 3 |")).toBe("| 1 | 4 > 3 → low = 3 |");
    expect(plainMath("$4 == 4 \\rightarrow$ return 3")).toBe("4 == 4 → return 3");
    expect(plainMath("runs in $O(n \\log n)$ time, $i \\le n$")).toBe("runs in O(n log n) time, i ≤ n");
  });

  it("leaves code, prices and plain dollars alone", () => {
    const code = "```java\nString s = \"$x$\";\n```";
    expect(plainMath(code)).toBe(code);
    expect(plainMath("use `echo $HOME $PATH`")).toBe("use `echo $HOME $PATH`");
    expect(plainMath("it costs $5 and $10 later")).toBe("it costs $5 and $10 later");
    expect(plainMath("nothing special")).toBe("nothing special");
  });
});
