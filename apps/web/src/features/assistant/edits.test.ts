import { describe, expect, it } from "vitest";
import { parseEditBlock, resolveEdit } from "./edits";

const CANDIES = `public class Candies {
    public static int search(int arr[], int s) {
        while (low <= high) {
            if (s < arr[mid]) {
                high = mid -
            } else {
                low = mid + 1;
            }
        }
    }
}
`;

const block = (body: string) => parseEditBlock(body)!;

describe("an edit with nothing to replace", () => {
  const add = block("FILE: sai.sql\n<<<<<<< ORIGINAL\n=======\nSELECT MAX(salary) FROM employees;\n>>>>>>> UPDATED\n");

  it("fills an empty file", () => {
    expect(resolveEdit("", add)).toMatchObject({ ok: true, content: "SELECT MAX(salary) FROM employees;\n", created: false, hunks: [{ startLine: 1, removed: [], added: ["SELECT MAX(salary) FROM employees;"] }] });
    expect(resolveEdit("\n  \n", add)).toMatchObject({ ok: true, content: "SELECT MAX(salary) FROM employees;\n" });
  });

  it("goes at the end of a file that has code, after a blank line", () => {
    expect(resolveEdit("SELECT 1;\n", add)).toMatchObject({ ok: true, content: "SELECT 1;\n\nSELECT MAX(salary) FROM employees;\n", hunks: [{ startLine: 2, removed: [] }] });
  });

  it("makes the file when the project has none of that name", () => {
    expect(resolveEdit(null, add)).toMatchObject({ ok: true, created: true });
  });
});

describe("an edit block written loosely, once the answer has ended", () => {
  const want = { file: "sai.sql", complete: true, hunks: [{ original: [], updated: ["SELECT 1;"] }] };

  it("is read without its end mark, without its ORIGINAL mark, or without any mark", () => {
    expect(parseEditBlock("FILE: sai.sql\n<<<<<<< ORIGINAL\n=======\nSELECT 1;\n", true)).toEqual(want);
    expect(parseEditBlock("FILE: sai.sql\n=======\nSELECT 1;\n>>>>>>> UPDATED\n", true)).toEqual(want);
    expect(parseEditBlock("FILE: sai.sql\n\nSELECT 1;\n", true)).toEqual(want);
  });

  it("is still incomplete while the answer is arriving", () => {
    expect(parseEditBlock("FILE: sai.sql\n<<<<<<< ORIGINAL\n=======\nSELECT 1;\n")!.complete).toBe(false);
    expect(parseEditBlock("FILE: sai.sql\nSELECT 1;\n")!.complete).toBe(false);
  });

  it("does not guess when the lines to replace were never closed", () => {
    expect(parseEditBlock("FILE: a.py\n<<<<<<< ORIGINAL\nx = 1\n", true)!.complete).toBe(false);
  });
});

describe("parseEditBlock", () => {
  it("reads the file and each ORIGINAL/UPDATED pair", () => {
    const b = block("FILE: Candies.java\n<<<<<<< ORIGINAL\n                high = mid -\n=======\n                high = mid - 1;\n>>>>>>> UPDATED\n");
    expect(b).toEqual({ file: "Candies.java", complete: true, hunks: [{ original: ["                high = mid -"], updated: ["                high = mid - 1;"] }] });
  });

  it("is incomplete while still streaming", () => {
    expect(block("FILE: Main.java\n<<<<<<< ORIGINAL\nx\n=======\ny").complete).toBe(false);
    expect(parseEditBlock("<<<<<<< ORIGINAL")).toBeNull();
  });
});

describe("resolveEdit", () => {
  it("replaces exactly the quoted line, wherever the cursor is", () => {
    const r = resolveEdit(CANDIES, block("FILE: Candies.java\n<<<<<<< ORIGINAL\n                high = mid -\n=======\n                high = mid - 1;\n>>>>>>> UPDATED"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe(CANDIES.replace("high = mid -\n", "high = mid - 1;\n"));
    expect(r.hunks).toEqual([{ startLine: 5, removed: ["                high = mid -"], added: ["                high = mid - 1;"] }]);
  });

  it("fixes the indentation when the model dropped it", () => {
    const r = resolveEdit(CANDIES, block("FILE: Candies.java\n<<<<<<< ORIGINAL\nhigh = mid -\n} else {\n=======\nhigh = mid - 1;\n} else {\n>>>>>>> UPDATED"));
    expect(r.ok && r.content).toContain("                high = mid - 1;\n            } else {\n");
  });

  it("applies several hunks in order and keeps Windows line endings", () => {
    const crlf = "a = 1\r\nb = 2\r\nc = 3\r\n";
    const r = resolveEdit(crlf, block("FILE: m.py\n<<<<<<< ORIGINAL\na = 1\n=======\na = 10\n>>>>>>> UPDATED\n<<<<<<< ORIGINAL\nc = 3\n=======\nc = 30\nd = 4\n>>>>>>> UPDATED"));
    expect(r.ok && r.content).toBe("a = 10\r\nb = 2\r\nc = 30\r\nd = 4\r\n");
  });

  it("refuses ambiguous or stale edits instead of guessing", () => {
    expect(resolveEdit("x = 1\nx = 1\n", block("FILE: m.py\n<<<<<<< ORIGINAL\nx = 1\n=======\nx = 2\n>>>>>>> UPDATED"))).toEqual({ ok: false, reason: "the lines to change appear more than once" });
    expect(resolveEdit("y = 1\n", block("FILE: m.py\n<<<<<<< ORIGINAL\nx = 1\n=======\nx = 2\n>>>>>>> UPDATED"))).toEqual({
      ok: false,
      reason: "the file no longer contains the lines this fix changes",
    });
  });

  it("creates a new file when ORIGINAL is empty", () => {
    const r = resolveEdit(null, block("FILE: util/Helper.java\n<<<<<<< ORIGINAL\n=======\nclass Helper {}\n>>>>>>> UPDATED"));
    expect(r).toEqual({ ok: true, content: "class Helper {}\n", hunks: [{ startLine: 1, removed: [], added: ["class Helper {}"] }], created: true });
  });
});
