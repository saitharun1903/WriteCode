import { describe, expect, it } from "vitest";
import { explainException, explainRuntimeError } from "./classify.js";

const java = (header: string, frames = "\tat Main.main(Main.java:5)") => `Exception in thread "main" ${header}\n${frames}\n`;
const python = (last: string) => `Traceback (most recent call last):\n  File "/workspace/main.py", line 3, in <module>\n    x()\n${last}\n`;

describe("plain explanations of common crashes", () => {
  it("explains Java index, null and arithmetic errors from their own messages", () => {
    expect(explainException(java("java.lang.ArrayIndexOutOfBoundsException: Index 2 out of bounds for length 2"))).toBe(
      "Index 2 is outside the array. Its length is 2, so valid indexes are 0 to 1.",
    );
    expect(explainException(java("java.lang.ArrayIndexOutOfBoundsException: Index 0 out of bounds for length 0"))).toBe(
      "Index 0 is outside the array. Its length is 0, so valid indexes are none (it is empty).",
    );
    expect(explainException(java("java.lang.IndexOutOfBoundsException: Index 3 out of bounds for length 3"))).toBe(
      "Index 3 is outside the list. Its size is 3, so valid indexes are 0 to 2.",
    );
    expect(explainException(java('java.lang.NullPointerException: Cannot assign field "next" because "tail" is null'))).toBe(
      "tail is null at this point, so its field next can't be set.",
    );
    expect(explainException(java('java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null'))).toBe(
      "name is null at this point, so length() can't be called on it.",
    );
    expect(explainException(java('java.lang.NullPointerException: Cannot invoke "String.length()" because "<local1>" is null'))).toBe(
      "Something used here is null: a variable or field was never given an object.",
    );
    expect(explainException(java("java.lang.ArithmeticException: / by zero"))).toBe("Integer division by zero.");
    expect(explainException(java('java.lang.NumberFormatException: For input string: "abc"'))).toBe('"abc" is not a number, so it can\'t be converted.');
    expect(explainException(java("java.util.NoSuchElementException"))).toContain("more input than it was given");
    expect(explainException(java("java.lang.StackOverflowError", "\tat Main.f(Main.java:3)\n".repeat(5)))).toContain("recursion never stopped");
  });

  it("explains Python's common errors from the last traceback line", () => {
    expect(explainException(python("IndexError: list index out of range"))).toBe("An index is past the end of the list. Valid indexes go from 0 to its length minus 1.");
    expect(explainException(python("ValueError: invalid literal for int() with base 10: 'x'"))).toBe("'x' is not a whole number, so int() can't convert it.");
    expect(explainException(python("EOFError: EOF when reading a line"))).toContain("no more input");
    expect(explainException(python("NameError: name 'totl' is not defined"))).toBe("totl is used before it is defined. Check the spelling, or define it first.");
    expect(explainException(python("KeyError: 'apple'"))).toBe("The key 'apple' is not in the dictionary. Use in to check first, or .get().");
    expect(explainException(python("ZeroDivisionError: division by zero"))).toBe("Division by zero.");
  });

  it("says nothing it does not recognise, and sandbox policies come first", () => {
    expect(explainException(java("com.example.MyOwnException: boom"))).toBeUndefined();
    expect(explainException("just some output")).toBeUndefined();
    expect(explainRuntimeError(1, python("OSError: [Errno 101] Network is unreachable"))).toBe("Network access is disabled in the sandbox.");
    expect(explainRuntimeError(1, java("java.lang.ArithmeticException: / by zero"))).toBe("Integer division by zero.");
    expect(explainRuntimeError(139, "")).toContain("SIGSEGV");
  });
});

describe("naming the line that ran out of input", () => {
  const CANDIES = [
    "public class Candies {",
    "    public static void main(String[] args) {",
    "        Scanner in = new Scanner(System.in);",
    "        int[] arr = new int[in.nextInt()];",
    "        for (int i = 0; i < arr.length; i++) arr[i] = in.nextInt();",
    "        int n = in.nextInt();",
    "    }",
    "}",
  ].join("\n");
  const files = [{ path: "Candies.java", content: CANDIES }];

  it("points at the user's line, not Scanner's, for the user's real stack trace", () => {
    const trace = `Exception in thread "main" java.util.NoSuchElementException
\tat java.base/java.util.Scanner.throwFor(Scanner.java:945)
\tat java.base/java.util.Scanner.next(Scanner.java:1602)
\tat java.base/java.util.Scanner.nextInt(Scanner.java:2267)
\tat java.base/java.util.Scanner.nextInt(Scanner.java:2221)
\tat Candies.main(Candies.java:6)
`;
    expect(explainRuntimeError(1, trace, files)).toBe(
      "Line 6 (int n = in.nextInt();) needed another value, but the input had no more. Check that the input gives every value the program reads, in the same order.",
    );
    // Without the project's files, the general explanation.
    expect(explainRuntimeError(1, trace)).toContain("more input than it was given");
  });

  it("names the line for Python too, using the innermost traceback entry in the project", () => {
    const py = [{ path: "main.py", content: "def read():\n    return int(input())\n\nn = read()\nm = read()\n" }];
    const trace = `Traceback (most recent call last):
  File "/workspace/main.py", line 5, in <module>
    m = read()
  File "/workspace/main.py", line 2, in read
    return int(input())
EOFError: EOF when reading a line
`;
    expect(explainRuntimeError(1, trace, py)).toBe(
      "Line 2 (return int(input())) needed another value, but the input had no more. Check that the input gives every value the program reads, in the same order.",
    );
    const bad = trace.replace("EOFError: EOF when reading a line", "ValueError: invalid literal for int() with base 10: 'abc'");
    expect(explainRuntimeError(1, bad, py)).toBe("Line 2 (return int(input())) expected a whole number but read 'abc'. Check the order of the values in the input.");
  });
});
