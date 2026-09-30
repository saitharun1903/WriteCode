import { describe, expect, it } from "vitest";
import { missingIncludes, missingJavaImports, missingPythonImports } from "./auto-import";

const main = (body: string, head = "") => `${head}public class Main {\n    public static void main(String[] args) {\n${body}\n    }\n}\n`;

describe("Java auto-import", () => {
  it("adds the imports for well-known classes at the top, sorted", () => {
    const code = main("        Scanner in = new Scanner(System.in);\n        List<Integer> xs = new ArrayList<>();\n        System.out.println(Arrays.toString(new int[0]));");
    expect(missingJavaImports(code, [code])).toEqual({
      lines: ["import java.util.ArrayList;", "import java.util.Arrays;", "import java.util.List;", "import java.util.Scanner;"],
      beforeLine: 1,
      blankAfter: true,
    });
  });

  it("appends to an existing import block and after a package line", () => {
    const withImport = main("        Map<String, Integer> m = new HashMap<>();", "import java.util.Map;\n\n");
    expect(missingJavaImports(withImport, [withImport])).toEqual({ lines: ["import java.util.HashMap;"], beforeLine: 2, blankAfter: false });
    const inPackage = `package app;\n\n${main("        Scanner in = new Scanner(System.in);")}`;
    expect(missingJavaImports(inPackage, [inPackage])).toEqual({ lines: ["", "import java.util.Scanner;"], beforeLine: 2, blankAfter: false });
  });

  it("never imports what is already covered, written by the user, or only in comments and strings", () => {
    const wildcard = main("        Scanner in = new Scanner(System.in);", "import java.util.*;\n\n");
    expect(missingJavaImports(wildcard, [wildcard])).toBeNull();
    const own = "public class Stack { }";
    const usesOwn = main("        Stack s = new Stack();");
    expect(missingJavaImports(usesOwn, [usesOwn, own])).toBeNull();
    const text = main('        // use a Scanner here\n        System.out.println("ArrayList and HashMap");');
    expect(missingJavaImports(text, [text])).toBeNull();
    const qualified = main("        java.util.Scanner in = new java.util.Scanner(System.in);");
    expect(missingJavaImports(qualified, [qualified])).toBeNull();
    const other = main("        List x = null;", "import java.awt.List;\n\n");
    expect(missingJavaImports(other, [other])).toBeNull();
  });

  it("waits while a name is still being typed", () => {
    const code = main("        List");
    const end = code.indexOf("List") + 4;
    expect(missingJavaImports(code, [code], end)).toBeNull();
    expect(missingJavaImports(code, [code], end + 1)).not.toBeNull();
  });
});

describe("Python auto-import", () => {
  it("imports modules used as module.name and names called from well-known modules", () => {
    expect(missingPythonImports("x = math.sqrt(2)\nq = deque()\nc = Counter('ab')\n")).toEqual({
      lines: ["import math", "from collections import Counter, deque"],
      beforeLine: 1,
      blankAfter: true,
    });
    expect(missingPythonImports("@lru_cache\ndef f(n):\n    return n\n")?.lines).toEqual(["from functools import lru_cache"]);
  });

  it("adds below existing imports and skips what is imported, defined or only mentioned", () => {
    expect(missingPythonImports("import sys\n\nprint(random.randint(1, 6))\n")).toEqual({ lines: ["import random"], beforeLine: 2, blankAfter: false });
    expect(missingPythonImports("import math\nprint(math.pi)\n")).toBeNull();
    expect(missingPythonImports("import numpy as np, math\nprint(math.pi)\n")).toBeNull();
    expect(missingPythonImports("from collections import deque\nq = deque()\n")).toBeNull();
    expect(missingPythonImports("def deque():\n    return []\nq = deque()\n")).toBeNull();
    expect(missingPythonImports("# math.sqrt\nprint('math.pi')\n")).toBeNull();
    expect(missingPythonImports("for math in range(3):\n    print(math.real)\n")).toBeNull();
  });
});

describe("C and C++ includes", () => {
  const apply = (code: string, edit: ReturnType<typeof missingIncludes>) => {
    if (!edit) return code;
    const lines = code.split("\n");
    lines.splice(edit.beforeLine - 1, 0, ...edit.lines, ...(edit.blankAfter ? [""] : []));
    return lines.join("\n");
  };

  it("adds C headers after the existing includes", () => {
    const code = '#include <stdio.h>\n\nint main(void) {\n    char s[] = "hi";\n    printf("%zu %d\\n", strlen(s), abs(-2));\n    bool ok = true;\n}\n';
    const edit = missingIncludes(code, false);
    expect(edit).toEqual({ lines: ["#include <stdbool.h>", "#include <stdlib.h>", "#include <string.h>"], beforeLine: 2, blankAfter: false });
    expect(missingIncludes(apply(code, edit), false)).toBeNull();
  });

  it("C++: std:: names, bare names only with using namespace std, C functions from the C++ headers", () => {
    expect(missingIncludes("int main() {\n    std::vector<int> v;\n    std::sort(v.begin(), v.end());\n}\n", true)?.lines).toEqual(["#include <algorithm>", "#include <vector>"]);
    expect(missingIncludes("int main() {\n    vector<int> v;\n}\n", true)).toBeNull();
    expect(missingIncludes("using namespace std;\nint main() {\n    vector<int> v;\n    cout << sqrt(2.0);\n}\n", true)?.lines).toEqual(["#include <cmath>", "#include <iostream>", "#include <vector>"]);
  });

  it("leaves bits/stdc++.h, the program's own names and names still being typed alone", () => {
    expect(missingIncludes("#include <bits/stdc++.h>\nint main() { std::vector<int> v; }\n", true)).toBeNull();
    expect(missingIncludes("int max(int a, int b) { return a > b ? a : b; }\nusing namespace std;\nint main() { return max(1, 2); }\n", true)).toBeNull();
    const code = "int main() {\n    printf";
    expect(missingIncludes(code, false, code.length)).toBeNull();
    expect(missingIncludes('int main() { puts("printf"); } // printf', false)?.lines).toEqual(["#include <stdio.h>"]);
  });
});
