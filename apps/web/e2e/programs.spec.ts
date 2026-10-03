import { expect, test, type Page } from "@playwright/test";

/**
 * Real programs through the real browser, API, queue, Docker sandbox, JVM and
 * debugger. Covers the required programs: the calculate() run and debug,
 * multi-file Java debugging, compiler and runtime errors, interactive stdin,
 * entry point selection and run-based recent projects.
 * Requires the full stack. Run with E2E_EXECUTION=1.
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(180_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const output = (page: Page) => page.getByRole("log", { name: "Program output" });
const debugPanel = (page: Page) => page.getByRole("complementary", { name: "Debugger" });
const variables = (page: Page) => debugPanel(page).getByRole("tree", { name: "Variables" });
const callStack = (page: Page) => debugPanel(page).getByRole("list", { name: "Call stack" });

/** Waits until autosave has written the project to IndexedDB (works against production builds too). */
async function waitSaved(page: Page) {
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

async function freshProject(page: Page, language: "Java" | "Python" | "JavaScript" | "TypeScript" | "C" | "C++" | "Kotlin" | "Ruby" | "Rust" | "Go" | "PHP" | "C#" | "Bash") {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("code-workspace");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByText("Runner online")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("heading", { name: "New project" }).waitFor();
  const tile = page.getByRole("button", { name: `New ${language} project` });
  // The languages past the first eight are behind "More languages".
  if (!(await tile.isVisible())) await page.getByRole("button", { name: "More languages" }).click();
  await tile.click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editor(page)).toContainText("Hello World");
}

/** Sets the open file's text through Monaco's model (no auto-indent rewriting the code). */
async function setCode(page: Page, code: string) {
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
  await waitSaved(page);
}

/** Creates a file at the project root through the explorer and fills it. */
async function addFile(page: Page, name: string, code: string) {
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("aria-selected", "true");
  await setCode(page, code);
}

async function openFile(page: Page, name: string) {
  await page.getByRole("treeitem", { name: new RegExp(name.replace(".", "\\.")) }).click();
  await expect(page.getByRole("tab", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("aria-selected", "true");
}

async function breakpointAt(page: Page, line: number) {
  await page.evaluate((l) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void; focus(): void }[] } } }).monaco;
    const ed = m.editor.getEditors()[0]!;
    ed.setPosition({ lineNumber: l, column: 1 });
    ed.focus();
  }, line);
  await page.keyboard.press("F9");
}

const activeTab = (page: Page, name: string) => expect(page.getByRole("tab", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("aria-selected", "true");

const CALCULATE = `public class Main {
    public static void main(String[] args) {
        int a = 10;
        int b = 20;

        int result = calculate(a, b);

        System.out.println("Result = " + result);
    }

    static int calculate(int x, int y) {
        int sum = x + y;
        return sum;
    }
}
`;

test("required program: runs, then the JVM pauses in calculate() with real values", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(page, CALCULATE);

  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Result = 30", { timeout: 120_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();

  await breakpointAt(page, 12);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("12:1");
  await expect(page.locator(".monaco-editor .cw-debug-line")).toHaveCount(1);
  await expect(variables(page).getByRole("treeitem", { name: "x = 10" })).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "y = 20" })).toBeVisible();
  // sum is not in scope before its declaration runs, so the debugger does not list it.
  await expect(variables(page).getByRole("treeitem", { name: /^sum = / })).toHaveCount(0);
  await expect(callStack(page).getByRole("button", { name: "calculate:12, Main" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "main:6, Main" })).toBeVisible();

  await page.keyboard.press("F10");
  await expect(debugPanel(page).getByText("Paused after step")).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("13:1");
  await expect(variables(page).getByRole("treeitem", { name: "sum = 30" })).toBeVisible();

  // Selecting the caller's frame shows the caller's locals and line.
  await callStack(page).getByRole("button", { name: /main:6, Main/ }).click();
  await expect(variables(page).getByRole("treeitem", { name: "a = 10" })).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "b = 20" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("6:1");

  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("Result = 30", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("multi-file Java: run, then step between Main, Calculator and Student", async ({ page }) => {
  await freshProject(page, "Java");
  await addFile(
    page,
    "Student.java",
    `public class Student {
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
`,
  );
  await addFile(
    page,
    "Calculator.java",
    `public class Calculator {
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
`,
  );
  await openFile(page, "Main.java");
  await setCode(
    page,
    `public class Main {
    public static void main(String[] args) {
        Student ada = new Student("Ada", 90, 85, 77);
        Calculator calc = new Calculator();
        int total = calc.total(ada);
        System.out.println(ada.getName() + " total=" + total + " avg=" + calc.average(ada));
    }
}
`,
  );

  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Ada total=252 avg=84.0", { timeout: 120_000 });

  await breakpointAt(page, 5);
  await openFile(page, "Student.java");
  await breakpointAt(page, 6);
  await page.getByRole("button", { name: "Debug program" }).click();

  // Constructor breakpoint in Student.java, called from Main.java.
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  await activeTab(page, "Student.java");
  await expect(callStack(page).getByRole("button", { name: "<init>:6, Student" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "main:3, Main" })).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: 'name = "Ada"' })).toBeVisible();

  // Continue to Main.java:5, then step into Calculator.total.
  await page.keyboard.press("F5");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("5:1");
  await activeTab(page, "Main.java");
  await page.keyboard.press("F11");
  await expect(debugPanel(page).getByText("Paused after step")).toBeVisible();
  await activeTab(page, "Calculator.java");
  await expect(callStack(page).getByRole("button", { name: "total:3, Calculator" })).toBeVisible();

  // Over the first line, then into Student.getMarks from the loop header.
  await page.keyboard.press("F10");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("4:1");
  await expect(variables(page).getByRole("treeitem", { name: "sum = 0" })).toBeVisible();
  await page.keyboard.press("F11");
  await activeTab(page, "Student.java");
  await expect(callStack(page).getByRole("button", { name: "getMarks:15, Student" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "total:4, Calculator" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "main:5, Main" })).toBeVisible();
  await variables(page).getByRole("treeitem", { name: /^this = Student/ }).click();
  await expect(variables(page).getByRole("treeitem", { name: "marks = int[3]" })).toBeVisible();

  // Out of Student, back in Calculator.
  await page.keyboard.press("Shift+F11");
  await activeTab(page, "Calculator.java");
  await expect(callStack(page).getByRole("button", { name: /^getMarks/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("Ada total=252 avg=84.0", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("required failures: real compiler error, real runtime exception", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(page, "public class Main {\n    public static void main(String[] args) {\n        int x =\n    }\n}\n");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Main.java:4: error: illegal start of expression", { timeout: 120_000 });
  await expect(page.getByText("Compilation error", { exact: true })).toBeVisible();

  await setCode(page, "public class Main {\n    public static void main(String[] args) {\n        int x = 10 / 0;\n    }\n}\n");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText('Exception in thread "main" java.lang.ArithmeticException: / by zero', { timeout: 120_000 });
  await expect(output(page)).toContainText("at Main.main(Main.java:3)");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible();
  await expect(output(page)).toContainText("Process finished with exit code 1");
});

test("interactive input: Scanner waits, receives 25 and prints 50", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(
    page,
    `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner scanner = new Scanner(System.in);
        int n = scanner.nextInt();
        System.out.println(n * 2);
        String word = scanner.next();
        System.out.println(word.toUpperCase());
    }
}
`,
  );
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByText("Program waiting for input")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Waiting for input", { exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeFocused();
  await input.fill("25");
  await page.keyboard.press("Enter");
  await expect(output(page)).toContainText("25\n50");
  await expect(page.getByText("Program waiting for input")).toBeVisible();
  await input.fill("sandbox");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(output(page)).toContainText("SANDBOX");
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
  await expect(input).toHaveCount(0);
});

test("debugging a program that reads input: Python pauses after the typed value", async ({ page }) => {
  await freshProject(page, "Python");
  await setCode(page, 'name = input("name? ")\ngreeting = "hi " + name\nprint(greeting)\n');
  await breakpointAt(page, 3);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(page.getByText("Program waiting for input")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("textbox", { name: "Program input" }).fill("Ada");
  await page.keyboard.press("Enter");
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "greeting = 'hi Ada'" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("hi Ada", { timeout: 30_000 });
});

test("debugging JavaScript: breakpoint, variables, step, input typed while it runs", async ({ page }) => {
  await freshProject(page, "JavaScript");
  await setCode(
    page,
    `const readline = require("node:readline");

function square(x) {
  const r = x * x;
  return r;
}

const nums = [3, 1, 2];
const rl = readline.createInterface({ input: process.stdin });
rl.once("line", (line) => {
  const n = Number(line);
  const total = square(n) + nums.length;
  console.log("total", total);
  rl.close();
});
`,
  );
  await breakpointAt(page, 4);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(page.getByText("Program waiting for input")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("textbox", { name: "Program input" }).fill("5");
  await page.keyboard.press("Enter");
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("4:1");
  await expect(variables(page).getByRole("treeitem", { name: "x = 5" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "square:4, main.js" })).toBeVisible();
  await page.keyboard.press("F10");
  await expect(debugPanel(page).getByText("Paused after step")).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "r = 25" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total 28", { timeout: 30_000 });
  // rl.close(): the program ends by itself, no Send EOF needed.
  await expect(page.getByText("Success", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("debugging TypeScript: exact lines across files, with an enum above", async ({ page }) => {
  await freshProject(page, "TypeScript");
  await addFile(page, "stack.ts", "export class Stack<T> {\n  private items: T[] = [];\n\n  push(x: T): void {\n    this.items.push(x);\n  }\n}\n");
  await openFile(page, "main.ts");
  await setCode(page, 'import { Stack } from "./stack.ts";\n\nenum Color {\n  Red,\n  Green,\n}\n\nconst s = new Stack<number>();\ns.push(Color.Green);\nconsole.log("pushed");\n');
  await openFile(page, "stack.ts");
  await breakpointAt(page, 5);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("5:1");
  await expect(variables(page).getByRole("treeitem", { name: "x = 1" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "push:5, Stack" })).toBeVisible();
  await expect(callStack(page).getByRole("button", { name: "(top level):9, main.ts" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("pushed", { timeout: 30_000 });
});

test("debugging C++: breakpoint in a class, vector and map values, step, safe watches", async ({ page }) => {
  await freshProject(page, "C++");
  await setCode(
    page,
    `#include <iostream>
#include <map>
#include <string>
#include <vector>

struct Stack {
    std::vector<int> items;
    void push(int x) {
        items.push_back(x);
    }
};

int main() {
    Stack s;
    s.push(3);
    s.push(4);
    std::map<std::string, int> ages = {{"ada", 36}};
    int total = s.items[0] + s.items[1];
    std::cout << "total " << total << std::endl;
    return 0;
}
`,
  );
  await breakpointAt(page, 18);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("18:1");
  await expect(variables(page).getByRole("treeitem", { name: "s = {items: [3, 4]}" })).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: 'ages = {"ada": 36}' })).toBeVisible();
  // Not declared yet on this line: no garbage value.
  await expect(variables(page).getByRole("treeitem", { name: /^total = / })).toHaveCount(0);
  await page.keyboard.press("F10");
  await expect(debugPanel(page).getByText("Paused after step")).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "total = 7" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total 7", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("debugging C: input typed while it runs, step into a function, a crash stops with the reason", async ({ page }) => {
  await freshProject(page, "C");
  await setCode(
    page,
    `#include <stdio.h>

int twice(int x) {
    int r = x * 2;
    return r;
}

int main(void) {
    int n;
    scanf("%d", &n);
    int d = twice(n);
    printf("d=%d\\n", d);
    int *p = NULL;
    printf("%d\\n", *p);
    return 0;
}
`,
  );
  await breakpointAt(page, 11);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(page.getByText("Program waiting for input")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("textbox", { name: "Program input" }).fill("21");
  await page.keyboard.press("Enter");
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "n = 21" })).toBeVisible();
  await page.keyboard.press("F11");
  await expect(callStack(page).getByRole("button", { name: "twice:4, main.c" })).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "x = 21" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(debugPanel(page).getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(debugPanel(page).getByText(/Segmentation fault/)).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "p = NULL" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(output(page)).toContainText("d=42");
});

test("several main classes: asks which to run and remembers the choice", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(page, "public class Main {\n    static String helper() {\n        return \"helper\";\n    }\n}\n");
  await addFile(page, "Tool.java", 'public class Tool {\n    public static void main(String[] args) {\n        System.out.println("tool " + Main.helper());\n    }\n}\n');
  await addFile(page, "Demo.java", 'public class Demo {\n    public static void main(String[] args) {\n        System.out.println("demo");\n    }\n}\n');

  // The open file is not a program, and neither is the entry file: two others are.
  await openFile(page, "Main.java");
  await page.getByRole("button", { name: "Run program" }).click();
  const dialog = page.getByRole("dialog", { name: "Select entry point" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Entry points" })).toContainText("Demo");
  await dialog.getByRole("button", { name: /^Tool/ }).click();
  await expect(output(page)).toContainText("tool helper", { timeout: 120_000 });

  await page.getByRole("button", { name: "Run program" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Success", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(output(page)).toContainText("tool helper");
  await expect(page.getByRole("button", { name: "Run configuration" })).toContainText("Tool.java");

  // A program in the editor is the one that runs.
  await openFile(page, "Demo.java");
  await expect(page.getByRole("button", { name: "Run configuration" })).toContainText("Demo.java");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("demo", { timeout: 120_000 });
  await expect(output(page)).not.toContainText("tool helper");
});

for (const [language, own, broken, program, expected] of [
  ["Java", "Second.java", "Broken.java", 'public class Second {\n    public static void main(String[] args) {\n        System.out.println("second runs");\n    }\n}\n', "second runs"],
  ["C++", "second.cpp", "broken.cpp", '#include <iostream>\nint main() {\n    std::cout << "second runs" << std::endl;\n}\n', "second runs"],
  ["C", "second.c", "broken.c", '#include <stdio.h>\nint main(void) {\n    printf("second runs\\n");\n    return 0;\n}\n', "second runs"],
  ["Python", "second.py", "broken.py", 'print("second runs")\n', "second runs"],
  ["JavaScript", "second.js", "broken.js", 'console.log("second runs");\n', "second runs"],
  ["TypeScript", "second.ts", "broken.ts", 'const text: string = "second runs";\nconsole.log(text);\n', "second runs"],
] as const) {
  test(`${language}: Run starts the file in the editor; a broken file beside it is left alone`, async ({ page }) => {
    await freshProject(page, language);
    await addFile(page, broken, "this is not a program {\n");
    await addFile(page, own, program);
    await expect(page.getByRole("button", { name: "Run configuration" })).toContainText(own);
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(output(page)).toContainText(expected, { timeout: 120_000 });
    await expect(page.getByText("Success", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(output(page)).not.toContainText("Hello World");

    // Back on the starter file, that is the one that runs.
    await page.getByRole("tab").first().click();
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(output(page)).toContainText("Hello World", { timeout: 120_000 });
    await expect(page.getByText("Success", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(output(page)).not.toContainText(expected);
  });
}

// A breakpoint set where there is no code: on a comment, with a blank line after it.
const NO_CODE: [Parameters<typeof freshProject>[1], string, number, number][] = [
  ["Java", "public class Main {\n    public static void main(String[] args) {\n        int total = 0;\n        // add them up\n\n        for (int i = 1; i <= 3; i++) total += i;\n        System.out.println(total);\n    }\n}\n", 4, 6],
  ["Python", "total = 0\n# add them up\n\nfor i in range(1, 4):\n    total += i\nprint(total)\n", 2, 4],
  ["C++", "#include <iostream>\n\nint main() {\n    int total = 0;\n    // add them up\n\n    for (int i = 1; i <= 3; i++) total += i;\n    std::cout << total << std::endl;\n    return 0;\n}\n", 5, 7],
  ["C", "#include <stdio.h>\n\nint main(void) {\n    int total = 0;\n    // add them up\n\n    for (int i = 1; i <= 3; i++) total += i;\n    printf(\"%d\\n\", total);\n    return 0;\n}\n", 5, 7],
  ["JavaScript", "let total = 0;\n// add them up\n\nfor (let i = 1; i <= 3; i++) total += i;\nconsole.log(total);\n", 2, 4],
  ["TypeScript", "let total: number = 0;\n// add them up\n\nfor (let i = 1; i <= 3; i++) total += i;\nconsole.log(total);\n", 2, 4],
  ["Kotlin", "fun main() {\n    var total = 0\n    // add them up\n\n    for (i in 1..3) total += i\n    println(total)\n}\n", 3, 5],
  ["Ruby", "total = 0\n# add them up\n\n(1..3).each { |i| total += i }\nputs total\n", 2, 4],
  ["Bash", "total=0\n# add them up\n\nfor i in 1 2 3; do total=$((total + i)); done\necho $total\n", 2, 4],
  ["C#", "class Program\n{\n    static void Main()\n    {\n        int total = 0;\n        // add them up\n\n        for (int i = 1; i <= 3; i++) total += i;\n        Console.WriteLine(total);\n    }\n}\n", 6, 8],
  ["PHP", "<?php\n$total = 0;\n// add them up\n\nfor ($i = 1; $i <= 3; $i++) {\n    $total += $i;\n}\necho $total;\n", 3, 5],
  ["Go", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\ttotal := 0\n\t// add them up\n\n\tfor i := 1; i <= 3; i++ {\n\t\ttotal += i\n\t}\n\tfmt.Println(total)\n}\n", 7, 9],
  ["Rust", "fn main() {\n    let mut total = 0;\n    // add them up\n\n    for i in 1..=3 {\n        total += i;\n    }\n    println!(\"{}\", total);\n}\n", 3, 5],
];

for (const [language, code, set, stops] of NO_CODE) {
  test(`${language}: a breakpoint on a line with no code stops on the next line that has some, and its mark moves there`, async ({ page }) => {
    await freshProject(page, language);
    await setCode(page, code);
    await breakpointAt(page, set);
    await page.getByRole("button", { name: "Debug program" }).click();
    // No list of steps before it starts: it just starts, and pauses.
    await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
    await expect(debugPanel(page).getByRole("list", { name: "Debugger progress" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(`${stops}:1`);
    // (PHP's variables are named with their $.)
    await expect(variables(page).getByRole("treeitem", { name: /^\$?total = 0$/ })).toBeVisible();
    // The red mark is on the line it stopped on, and is a real breakpoint (not a greyed one).
    await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);
    await expect(page.locator(".monaco-editor .cw-bp-unverified")).toHaveCount(0);
    // Same row as the line the program is paused on.
    const mark = (await page.locator(".monaco-editor .cw-bp").boundingBox())!;
    const paused = (await page.locator(".monaco-editor .cw-debug-line").boundingBox())!;
    expect(Math.abs(mark.y - paused.y)).toBeLessThan(3);
    await page.keyboard.press("Shift+F5");
  });
}

test("recent projects: running the untouched starter does not count; changing the code does", async ({ page }) => {
  await freshProject(page, "Python");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Hello World", { timeout: 120_000 });
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByRole("list", { name: "Recent projects" })).toHaveCount(0);

  await page.getByRole("button", { name: "New Python project" }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello");
  await setCode(page, `print('mine')
`);
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("mine", { timeout: 120_000 });
  await page.getByRole("button", { name: "Home" }).click();
  const recent = page.getByRole("list", { name: "Recent projects" });
  await expect(recent.getByRole("listitem")).toHaveCount(1);
  await expect(recent).toContainText("Ran just now");
});

test("the bottom panel stays closed when a project opens, and Run opens it", async ({ page }) => {
  await freshProject(page, "Java");
  await expect(page.getByRole("region", { name: "Run" })).toBeHidden();
  await setCode(page, CALCULATE.replace("calculate(a, b)", "calculate(a, b) + 0"));
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Process finished", { timeout: 120_000 });
  // Reopening from the start screen starts on the code again.
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("list", { name: "Recent projects" }).getByRole("listitem").first().click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("calculate");
  await expect(page.getByRole("region", { name: "Run" })).toBeHidden();
});

test("editing code clears the old error marks; they do not stay on a line that changed", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(page, `public class Main {
    public static void main(String[] args) {
        int n = 1;
        int n = 2;
    }
}
`);
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("already defined", { timeout: 120_000 });
  await expect(page.locator(".monaco-editor .squiggly-error")).not.toHaveCount(0);
  await setCode(page, `public class Main {
    public static void main(String[] args) {
        int n = 1;

    }
}
`);
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(0);
});

test("a dropped connection does not lose the result: the run finishes and shows its output", async ({ page }) => {
  // Cut the live event stream right after it connects; the program keeps running on the server.
  await page.routeWebSocket(/\/ws/, (ws) => {
    ws.connectToServer();
    setTimeout(() => void ws.close({ code: 1011, reason: "test drop" }), 150);
  });
  await freshProject(page, "Python");
  await setCode(page, `import time
time.sleep(1)
print('still here')
`);
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("still here", { timeout: 60_000 });
  await expect(output(page)).toContainText("Process finished with exit code 0");
});

test("debugging a program that reads input: Java stops at a breakpoint after the typed value", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(
    page,
    "import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        int n = new Scanner(System.in).nextInt();\n        int doubled = n * 2;\n        System.out.println(doubled);\n    }\n}\n",
  );
  await breakpointAt(page, 7);
  await page.getByRole("button", { name: "Debug program" }).click();
  await expect(page.getByText("Program waiting for input")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("textbox", { name: "Program input" }).fill("25");
  await page.keyboard.press("Enter");
  await expect(debugPanel(page).getByText("Paused on breakpoint")).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "n = 25" })).toBeVisible();
  await expect(variables(page).getByRole("treeitem", { name: "doubled = 50" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("50", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("visualizer: starts where the logic starts, and steps through a recorded Python run with its calls, variables and output", async ({ page }) => {
  await freshProject(page, "Python");
  await setCode(
    page,
    'def square(x):\n    return x * x\n\n\nnums = [1, 2]\nalias = nums\nresult = square(3)\nprint("result", result)\nnums.append(result)\n',
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  // The first lines only prepare things (a function, a list, a second name for it): the steps start at the call.
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await expect(viz.getByText("main.py:7")).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to line" })).not.toHaveText("");
  // One view, with nothing to choose: the structures.
  await expect(viz.getByRole("group", { name: "View" })).toHaveCount(0);
  const stack = viz.getByRole("navigation", { name: "Call stack" });
  await expect(stack).toHaveText("<module>");
  await expect(viz.getByRole("region", { name: /nums$/ })).toContainText("2");
  await expect(page.locator(".monaco-editor .cw-debug-line")).toHaveCount(1);
  // The line that just ran is marked too.
  await expect(page.locator(".monaco-editor .cw-viz-ran-line")).toHaveCount(1);
  const happened = viz.getByLabel("What happened");
  await expect(happened).toContainText("alias = [1, 2]");
  await expect(viz.getByRole("button", { name: "Previous step" })).toBeDisabled();

  // The steps that prepare the data are one click away, and one click from hidden again.
  const setup = viz.getByRole("button", { name: "Setup steps" });
  await setup.click();
  await expect(setup).toHaveAttribute("aria-pressed", "true");
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible();
  await expect(viz.getByText(/main\.py:1$/)).toBeVisible();
  await setup.click();
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible();
  await expect(viz.getByText("main.py:7")).toBeVisible();

  // Into square(3): a second call, then its return value.
  const next = viz.getByRole("button", { name: "Next step" });
  await next.click();
  await expect(happened).toContainText("Called square(x=3)");
  await expect(stack).toContainText("square");
  await expect(viz.getByLabel("Variables")).toContainText("3");
  await next.click();
  await expect(happened).toContainText("square returns 9");
  await next.click();
  await expect(happened).toContainText("result = 9");

  // Output appears only from the step after print().
  await expect(viz.getByLabel("Output so far")).toHaveText("Nothing printed yet");
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByLabel("Output so far")).toHaveText("result 9");
  await expect(viz.getByRole("region", { name: /nums$/ })).toContainText("9");

  // Keyboard stepping backwards from the end: to where the logic starts.
  await viz.getByRole("button", { name: "Previous step" }).focus();
  await page.keyboard.press("Home");
  await expect(viz.getByText(/^Step 1 of/)).toBeVisible();
  await expect(viz.getByText("main.py:7")).toBeVisible();

  // Play runs through the steps by itself and stops at the end.
  await viz.getByRole("button", { name: "4×" }).click();
  await viz.getByRole("button", { name: "Play" }).click();
  await expect(viz.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(viz.getByRole("button", { name: "Next step" })).toBeDisabled({ timeout: 30_000 });
  await expect(viz.getByRole("button", { name: "Play" })).toBeVisible();
  await expect(happened).toContainText("Program finished");
});

test("visualizer: a linked list built by hand is already there; the steps start at the loop that walks it, in every language", async ({ page }) => {
  // [language, code, the line of the loop, the file]
  const programs: [Parameters<typeof freshProject>[1], string, number, string][] = [
    [
      "Java",
      "public class Main {\n    static class Node {\n        int val;\n        Node next;\n        Node(int val) { this.val = val; }\n    }\n\n    public static void main(String[] args) {\n        Node head = new Node(1);\n        Node second = new Node(2);\n        Node third = new Node(3);\n        head.next = second;\n        second.next = third;\n        Node cur = head;\n        int total = 0;\n        while (cur != null) {\n            total += cur.val;\n            cur = cur.next;\n        }\n        System.out.println(total);\n    }\n}\n",
      16,
      "Main.java",
    ],
    [
      "Python",
      "class Node:\n    def __init__(self, val):\n        self.val = val\n        self.next = None\n\n\nhead = Node(1)\nsecond = Node(2)\nthird = Node(3)\nhead.next = second\nsecond.next = third\ncur = head\ntotal = 0\nwhile cur:\n    total += cur.val\n    cur = cur.next\nprint(total)\n",
      14,
      "main.py",
    ],
    [
      "C++",
      "#include <iostream>\n\nstruct Node {\n    int val;\n    Node* next;\n    Node(int v) : val(v), next(nullptr) {}\n};\n\nint main() {\n    Node* head = new Node(1);\n    Node* second = new Node(2);\n    Node* third = new Node(3);\n    head->next = second;\n    second->next = third;\n    Node* cur = head;\n    int total = 0;\n    while (cur != nullptr) {\n        total += cur->val;\n        cur = cur->next;\n    }\n    std::cout << total << std::endl;\n    return 0;\n}\n",
      17,
      "main.cpp",
    ],
    [
      "Kotlin",
      "class Node(val value: Int) {\n    var next: Node? = null\n}\n\nfun main() {\n    val head = Node(1)\n    val second = Node(2)\n    val third = Node(3)\n    head.next = second\n    second.next = third\n    var cur: Node? = head\n    var total = 0\n    while (cur != null) {\n        total += cur.value\n        cur = cur.next\n    }\n    println(total)\n}\n",
      13,
      "Main.kt",
    ],
    [
      "C#",
      "class Node\n{\n    public int Val;\n    public Node Next;\n    public Node(int val) { Val = val; }\n}\n\nclass Program\n{\n    static void Main()\n    {\n        var head = new Node(1);\n        var second = new Node(2);\n        var third = new Node(3);\n        head.Next = second;\n        second.Next = third;\n        var cur = head;\n        int total = 0;\n        while (cur != null)\n        {\n            total += cur.Val;\n            cur = cur.Next;\n        }\n        Console.WriteLine(total);\n    }\n}\n",
      19,
      "Program.cs",
    ],
    [
      "PHP",
      "<?php\nclass Node {\n    public $val;\n    public $next = null;\n    public function __construct($val) { $this->val = $val; }\n}\n\n$head = new Node(1);\n$second = new Node(2);\n$third = new Node(3);\n$head->next = $second;\n$second->next = $third;\n$cur = $head;\n$total = 0;\nwhile ($cur !== null) {\n    $total += $cur->val;\n    $cur = $cur->next;\n}\necho $total;\n",
      // Like Ruby, PHP reports a while line once, then the lines of its body on each pass.
      16,
      "main.php",
    ],
    [
      "Go",
      "package main\n\nimport \"fmt\"\n\ntype Node struct {\n\tVal  int\n\tNext *Node\n}\n\nfunc main() {\n\thead := &Node{Val: 1}\n\tsecond := &Node{Val: 2}\n\tthird := &Node{Val: 3}\n\thead.Next = second\n\tsecond.Next = third\n\tcur := head\n\ttotal := 0\n\tfor cur != nil {\n\t\ttotal += cur.Val\n\t\tcur = cur.Next\n\t}\n\tfmt.Println(total)\n}\n",
      18,
      "main.go",
    ],
    [
      "Rust",
      "struct Node {\n    val: i32,\n    next: Option<Box<Node>>,\n}\n\nfn main() {\n    let mut head = Node { val: 1, next: None };\n    head.next = Some(Box::new(Node { val: 2, next: Some(Box::new(Node { val: 3, next: None })) }));\n    let mut cur = Some(&head);\n    let mut total = 0;\n    while let Some(node) = cur {\n        total += node.val;\n        cur = node.next.as_deref();\n    }\n    println!(\"{}\", total);\n}\n",
      11,
      "main.rs",
    ],
    [
      "Ruby",
      "class Node\n  attr_accessor :val, :next\n\n  def initialize(val)\n    @val = val\n    @next = nil\n  end\nend\n\nhead = Node.new(1)\nsecond = Node.new(2)\nthird = Node.new(3)\nhead.next = second\nsecond.next = third\ncur = head\ntotal = 0\nwhile cur\n  total += cur.val\n  cur = cur.next\nend\nputs total\n",
      // Ruby reports a while line once, then the lines of its body on each pass: the walk starts at the first of them.
      18,
      "main.rb",
    ],
    [
      "JavaScript",
      "class Node {\n  constructor(val) {\n    this.val = val;\n    this.next = null;\n  }\n}\n\nconst head = new Node(1);\nconst second = new Node(2);\nconst third = new Node(3);\nhead.next = second;\nsecond.next = third;\nlet cur = head;\nlet total = 0;\nwhile (cur) {\n  total += cur.val;\n  cur = cur.next;\n}\nconsole.log(total);\n",
      15,
      "main.js",
    ],
  ];
  for (const [language, code, loop, file] of programs) {
    await freshProject(page, language);
    await setCode(page, code);
    await page.getByRole("button", { name: "Visualize execution" }).click();
    const viz = page.getByRole("region", { name: "Visualize" });
    await expect(viz.getByText(/^Step 1 of \d+$/), language).toBeVisible({ timeout: 120_000 });
    // The first step shown is the loop, with the whole list already drawn.
    await expect(viz.getByText(`${file}:${loop}`), language).toBeVisible();
    const list = viz.getByRole("region", { name: "Singly linked list head" });
    for (const value of ["1", "2", "3"]) await expect(list, language).toContainText(value);
    await expect(viz.getByRole("button", { name: "Previous step" }), language).toBeDisabled();
    // The steps that made the nodes are there for whoever wants them.
    await viz.getByRole("button", { name: "Setup steps" }).click();
    await expect(viz.getByText(`${file}:${loop}`), language).toHaveCount(0);
    await viz.getByRole("button", { name: "Last step" }).click();
    await expect(viz.getByLabel("Output so far"), language).toHaveText("6");
  }
});

test("visualizer: animates a swap, index pointers and a linked list", async ({ page }) => {
  await freshProject(page, "Python");
  await setCode(
    page,
    "class Node:\n    def __init__(self, value, next=None):\n        self.value = value\n        self.next = next\n\n\narr = [3, 1]\ni = 0\narr[i], arr[i + 1] = arr[i + 1], arr[i]\nhead = Node(1, Node(2))\nprint(arr)\n",
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  // Nothing here but a straight line of statements: every step is shown.
  await expect(viz.getByRole("button", { name: "Setup steps" })).toHaveCount(0);
  const happened = viz.getByLabel("What happened");
  const next = viz.getByRole("button", { name: "Next step" });
  while (!((await happened.textContent()) ?? "").includes("Swapped")) await next.click();
  await expect(happened).toContainText("Swapped arr[0] and arr[1]");
  const arr = viz.getByRole("region", { name: /arr$/ });
  await expect(arr).toContainText("1");
  await expect(arr).toContainText("3");
  // `i` points at element 0 of arr.
  await expect(arr.getByText("i", { exact: true })).toBeVisible();

  await viz.getByRole("button", { name: "Last step" }).click();
  // The two nodes are drawn as the list they make.
  const list = viz.getByRole("region", { name: "Singly linked list head" });
  await expect(list).toContainText("1");
  await expect(list).toContainText("2");
  await expect(viz.getByLabel("Output so far")).toHaveText("[1, 3]");
});

test("visualizer: records a Java run across classes", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(
    page,
    "import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        List<Integer> xs = new ArrayList<>();\n        xs.add(4);\n        Box b = new Box(xs);\n        System.out.println(b.items.size());\n    }\n}\n\nclass Box {\n    List<Integer> items;\n\n    Box(List<Integer> items) {\n        this.items = items;\n    }\n}\n",
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByLabel("Output so far")).toHaveText("1");
  await expect(viz.getByRole("region", { name: /xs$/ })).toContainText("4");
  await expect(viz.getByRole("navigation", { name: "Call stack" })).toContainText("Main.main");
});

test("console shows only the program's output, not the sandbox's command line", async ({ page }) => {
  await freshProject(page, "Java");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Hello World", { timeout: 90_000 });
  await expect(output(page)).not.toContainText("-XX:");
  await expect(output(page)).not.toContainText("Running Main.java");
});

test("assistant effort: faster to smarter, remembered across reloads", async ({ page }) => {
  await freshProject(page, "Python");
  await page.getByRole("button", { name: "AI Assistant" }).click();
  const chip = page.getByRole("button", { name: /^Effort:/ });
  await expect(chip).toHaveAccessibleName("Effort: Medium");
  await chip.click();
  const slider = page.getByRole("slider", { name: "Reasoning effort" });
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(chip).toHaveAccessibleName("Effort: Low");
  await expect(page.getByRole("dialog", { name: "Reasoning effort" })).toContainText("Fastest answers");
  await page.keyboard.press("End");
  await expect(chip).toHaveAccessibleName("Effort: High");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Reasoning effort" })).toHaveCount(0);
  // The panel stays open across reloads (layout is remembered), and so does the effort.
  await page.reload();
  await expect(page.getByRole("button", { name: /^Effort:/ })).toHaveAccessibleName("Effort: High", { timeout: 30_000 });
});

test("stack trace and compiler locations in the console open the editor at that line", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(page, "public class Main {\n    public static void main(String[] args) {\n        int[] a = new int[2];\n        System.out.println(Helper.third(a));\n    }\n}\n");
  await addFile(page, "Helper.java", "public class Helper {\n    static int third(int[] a) {\n        return a[2];\n    }\n}\n");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("ArrayIndexOutOfBoundsException", { timeout: 90_000 });
  // A plain explanation from the exception's own message.
  await expect(output(page)).toContainText("Index 2 is outside the array. Its length is 2, so valid indexes are 0 to 1.");

  await output(page).getByRole("button", { name: "Helper.java:3" }).click();
  await activeTab(page, "Helper.java");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(/^3:/);
  await output(page).getByRole("button", { name: "Main.java:4" }).click();
  await activeTab(page, "Main.java");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(/^4:/);
});

test("errors and output belong to their project: opening another project starts clean", async ({ page }) => {
  await freshProject(page, "Java");
  await setCode(page, `public class Main {
    public static void main(String[] args) {
        int n = 1;
        int n = 2;
    }
}
`);
  // A quick double press starts one run, not two.
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/executions$/.test(r.url())) posts.push(r.url());
  });
  await page.getByRole("button", { name: "Run program" }).dblclick();
  await expect(output(page)).toContainText("already defined", { timeout: 120_000 });
  expect(posts).toHaveLength(1);
  await expect(page.locator(".monaco-editor .squiggly-error")).not.toHaveCount(0);

  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New Java project" }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello");
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(0);
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Hello", { timeout: 120_000 });
  await expect(output(page)).not.toContainText("already defined");
});

test("visualizer: draws each data structure as its concept", async ({ page }) => {
  await freshProject(page, "Python");
  await setCode(
    page,
    [
      "from collections import deque",
      "",
      "class Node:",
      "    def __init__(self, val):",
      "        self.val = val",
      "        self.left = None",
      "        self.right = None",
      "",
      "def insert(root, val):",
      "    if root is None:",
      "        return Node(val)",
      "    if val < root.val:",
      "        root.left = insert(root.left, val)",
      "    else:",
      "        root.right = insert(root.right, val)",
      "    return root",
      "",
      "root = None",
      "for v in [8, 3, 10]:",
      "    root = insert(root, v)",
      "stack = [1, 2]",
      "stack.append(3)",
      "queue = deque([4, 5])",
      "queue.popleft()",
      "graph = {0: [1], 1: [0, 2], 2: [1]}",
      "visited = [True, False, False]",
      "freq = {'a': 1}",
      "print('done')",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByRole("region", { name: "Binary search tree root" })).toContainText("10");
  await expect(viz.getByRole("region", { name: "Stack stack" })).toContainText("Top");
  await expect(viz.getByRole("region", { name: "Queue queue" })).toContainText("5");
  await expect(viz.getByRole("region", { name: "Queue queue" })).not.toContainText("4");
  await expect(viz.getByRole("region", { name: "Graph graph" })).toContainText("visited (1)");
  await expect(viz.getByRole("region", { name: "Hash map freq" })).toContainText("'a'");
});

test("visualizer: JavaScript and TypeScript are drawn as their structures too", async ({ page }) => {
  await freshProject(page, "JavaScript");
  await setCode(
    page,
    [
      "class ListNode {",
      "  constructor(val, next = null) {",
      "    this.val = val;",
      "    this.next = next;",
      "  }",
      "}",
      "const head = new ListNode(1, new ListNode(2));",
      "const graph = new Map([[0, [1]], [1, [0, 2]], [2, [1]]]);",
      "const stack = [4, 5];",
      "stack.pop();",
      "const freq = {};",
      "freq.a = 1;",
      "console.log(head.val, stack.length);",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByRole("region", { name: "Singly linked list head" })).toContainText("2");
  await expect(viz.getByRole("region", { name: "Graph graph" })).toBeVisible();
  await expect(viz.getByRole("region", { name: "Stack stack" })).toContainText("4");
  await expect(viz.getByRole("region", { name: "Object freq" })).toContainText('"a"');
  await expect(viz.getByLabel("Output so far")).toHaveText("1 1");

  await freshProject(page, "TypeScript");
  await setCode(page, ["enum Dir {", "  Up,", "  Down,", "}", "const moves: Dir[] = [Dir.Up, Dir.Down];", "const last: Dir = moves[1];", "console.log(last);", ""].join("\n"));
  await page.getByRole("button", { name: "Visualize execution" }).click();
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByLabel("Output so far")).toHaveText("1");
  // Lines are the lines as written: the last step is on the console.log line.
  await expect(viz.getByText(/main\.ts:7/)).toBeVisible();
});

test("visualizer: C and C++ are drawn as their structures too", async ({ page }) => {
  await freshProject(page, "C++");
  await setCode(
    page,
    [
      "#include <iostream>",
      "#include <map>",
      "#include <queue>",
      "#include <stack>",
      "#include <vector>",
      "",
      "struct Node {",
      "    int val;",
      "    Node *next;",
      "};",
      "",
      "int main() {",
      "    Node *head = new Node{1, new Node{2, nullptr}};",
      "    std::stack<int> st;",
      "    st.push(4);",
      "    st.push(5);",
      "    st.pop();",
      "    std::queue<int> q;",
      "    q.push(7);",
      "    std::map<std::string, int> ages = {{\"ada\", 36}};",
      "    std::vector<std::vector<int>> adj = {{1}, {0, 2}, {1}};",
      "    std::cout << head->val << \" \" << st.top() << std::endl;",
      "    return 0;",
      "}",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByRole("region", { name: "Singly linked list head" })).toContainText("2");
  await expect(viz.getByRole("region", { name: "Stack st" })).toContainText("4");
  await expect(viz.getByRole("region", { name: "Queue q" })).toContainText("7");
  await expect(viz.getByRole("region", { name: "Sorted map ages" })).toContainText("ada");
  await expect(viz.getByRole("region", { name: "Graph adj" })).toBeVisible();
  await expect(viz.getByLabel("Output so far")).toHaveText("1 4");

  await freshProject(page, "C");
  await setCode(
    page,
    [
      "#include <stdio.h>",
      "",
      "int stack[5];",
      "int top = -1;",
      "",
      "void push(int x) {",
      "    stack[++top] = x;",
      "}",
      "",
      "int main(void) {",
      "    int arr[4] = {4, 3, 2, 1};",
      "    push(10);",
      "    push(20);",
      '    printf("%d\\n", stack[top] + arr[0]);',
      "    return 0;",
      "}",
      "",
    ].join("\n"),
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByRole("region", { name: "Stack stack" })).toContainText("20");
  await expect(viz.getByLabel("Output so far")).toHaveText("24");
});

test("visualizer: a program that asks for input can be answered right in the Visualize panel, in every language", async ({ page }) => {
  const programs: [Parameters<typeof freshProject>[1], string][] = [
    ["C", '#include <stdio.h>\n\nint main(void) {\n    int n;\n    printf("number? ");\n    scanf("%d", &n);\n    printf("%d\\n", n * 2);\n    return 0;\n}\n'],
    ["C++", "#include <iostream>\n\nint main() {\n    int n;\n    std::cout << \"number? \";\n    std::cin >> n;\n    std::cout << n * 2 << std::endl;\n}\n"],
    ["Python", 'n = int(input("number? "))\nprint(n * 2)\n'],
    ["Java", 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        System.out.print("number? ");\n        int n = in.nextInt();\n        System.out.println(n * 2);\n    }\n}\n'],
    ["JavaScript", 'const n = Number(require("node:fs").readFileSync(0, "utf8").trim());\nconsole.log(n * 2);\n'],
    ["TypeScript", 'import { readFileSync } from "node:fs";\nconst n: number = Number(readFileSync(0, "utf8").trim());\nconsole.log(n * 2);\n'],
  ];
  for (const [language, code] of programs) {
    await freshProject(page, language);
    await setCode(page, code);
    // Start from another tab: the input must still be reachable.
    await page.getByRole("button", { name: "Visualize execution" }).click();
    const viz = page.getByRole("region", { name: "Visualize" });
    await expect(viz.getByText(/waiting for your input/), language).toBeVisible({ timeout: 120_000 });
    const input = viz.getByRole("textbox", { name: "Program input" });
    await input.fill("21");
    await page.keyboard.press("Enter");
    // Node reads until the input ends.
    if (language === "JavaScript" || language === "TypeScript") await viz.getByRole("button", { name: "Send EOF" }).click();
    await expect(viz.getByText(/^Step 1 of \d+$/), language).toBeVisible({ timeout: 120_000 });
    await viz.getByRole("button", { name: "Last step" }).click();
    await expect(viz.getByLabel("Output so far"), language).toContainText("42");
  }
});

test("a program asking for input brings its console back, even from another tab", async ({ page }) => {
  await freshProject(page, "Python");
  // The pause gives time to look at another tab before the second question.
  await setCode(page, 'import time\n\na = input("first? ")\ntime.sleep(2)\nb = input("second? ")\nprint(a + b)\n');
  await page.getByRole("button", { name: "Run program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(page.getByText("Program waiting for input")).toBeVisible({ timeout: 120_000 });
  await input.fill("x");
  await page.keyboard.press("Enter");
  // Looking at the tests while it runs: the next question must not go unseen.
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(page.getByRole("region", { name: "Run" })).toBeVisible({ timeout: 30_000 });
  await input.fill("y");
  await page.keyboard.press("Enter");
  await expect(output(page)).toContainText("xy", { timeout: 30_000 });
});

test("JavaScript and TypeScript programs that read with readline end by themselves, like in a terminal", async ({ page }) => {
  const programs = [
    [
      "JavaScript",
      [
        'const readline = require("node:readline");',
        "",
        "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
        'rl.question("a? ", (a) => {',
        '  rl.question("b? ", (b) => {',
        '    console.log("sum", Number(a) + Number(b));',
        "    rl.close();",
        "  });",
        "});",
        "",
      ].join("\n"),
    ],
    [
      "TypeScript",
      [
        'import * as readline from "node:readline/promises";',
        "",
        "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
        'const a: string = await rl.question("a? ");',
        'const b: string = await rl.question("b? ");',
        'console.log("sum", Number(a) + Number(b));',
        "rl.close();",
        "",
      ].join("\n"),
    ],
  ] as const;
  for (const [language, code] of programs) {
    await freshProject(page, language);
    await setCode(page, code);
    await page.getByRole("button", { name: "Run program" }).click();
    const input = page.getByRole("textbox", { name: "Program input" });
    await expect(page.getByText("Program waiting for input"), language).toBeVisible({ timeout: 120_000 });
    await input.fill("2");
    await page.keyboard.press("Enter");
    await expect(output(page)).toContainText("b?", { timeout: 30_000 });
    await input.fill("5");
    await page.keyboard.press("Enter");
    await expect(output(page)).toContainText("sum 7", { timeout: 30_000 });
    // No Send EOF: closing readline ends the program.
    await expect(page.getByText("Success", { exact: true }), language).toBeVisible({ timeout: 30_000 });
  }
});
