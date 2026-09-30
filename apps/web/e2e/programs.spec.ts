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

async function freshProject(page: Page, language: "Java" | "Python" | "JavaScript" | "TypeScript" | "C" | "C++") {
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
  await page.getByRole("button", { name: `New ${language} project` }).click();
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
  // As in a normal run, Node keeps stdin open until the input ends.
  await page.getByRole("button", { name: "Send EOF" }).click();
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
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
});

test("recent projects: running the untouched starter does not count; changing the code does", async ({ page }) => {
  await freshProject(page, "Python");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("Hello World", { timeout: 120_000 });
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByRole("list", { name: "Recent projects" })).toHaveCount(0);

  await page.getByRole("button", { name: "New Python project" }).click();
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

test("visualizer: steps through a recorded Python run with frames, objects and output", async ({ page }) => {
  await freshProject(page, "Python");
  await setCode(
    page,
    'def square(x):\n    return x * x\n\n\nnums = [1, 2]\nalias = nums\nresult = square(3)\nprint("result", result)\nnums.append(result)\n',
  );
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  await viz.getByRole("button", { name: "memory" }).click();
  const frames = viz.getByRole("region", { name: "Frames" });
  const objects = viz.getByRole("region", { name: "Objects" });
  await expect(frames.getByRole("group", { name: "Frame <module>" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Go to line" })).not.toHaveText("");

  // Step forward to line 7 (after nums and alias exist): both names point at one list.
  const next = viz.getByRole("button", { name: "Next step" });
  while (!(await viz.getByText("main.py:7").isVisible())) await next.click();
  await expect(objects.getByRole("group", { name: "list object" })).toHaveCount(1);
  await expect(frames.getByRole("row", { name: "nums = reference" })).toBeVisible();
  await expect(frames.getByRole("row", { name: "alias = reference" })).toBeVisible();
  // Functions are shown inline; nums and alias both have an arrow to the one list.
  await expect(frames.getByRole("row", { name: "square = function square(x)" })).toBeVisible();
  await expect(viz.locator("svg path[marker-end]")).toHaveCount(2);
  await expect(page.locator(".monaco-editor .cw-debug-line")).toHaveCount(1);
  // The line that just ran is marked too.
  await expect(page.locator(".monaco-editor .cw-viz-ran-line")).toHaveCount(1);
  const happened = viz.getByLabel("What happened");
  await expect(happened).toContainText("alias = [1, 2]");
  // Optionally as objects with their own arrows.
  await viz.getByRole("button", { name: "Show functions and classes as objects" }).click();
  await expect(objects.getByRole("group", { name: "function object" })).toContainText("square(x)");
  await expect(viz.locator("svg path[marker-end]")).toHaveCount(3);
  await viz.getByRole("button", { name: "Show functions and classes as objects" }).click();

  // Into square(3): a second frame, then its return value.
  await next.click();
  await expect(happened).toContainText("Called square(x=3)");
  await expect(frames.getByRole("group", { name: "Frame square" })).toBeVisible();
  await expect(frames.getByRole("row", { name: "x = 3" })).toBeVisible();
  await next.click();
  await expect(happened).toContainText("square returns 9");
  await expect(frames.getByRole("row", { name: "return value = 9" })).toBeVisible();
  await next.click();
  await expect(happened).toContainText("result = 9");

  // Output appears only from the step after print().
  await expect(viz.getByLabel("Output so far")).toHaveText("Nothing printed yet");
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByLabel("Output so far")).toHaveText("result 9");
  await expect(objects.getByRole("group", { name: "list object" })).toContainText("9");

  // Keyboard stepping backwards from the end.
  await viz.getByRole("button", { name: "Previous step" }).focus();
  await page.keyboard.press("Home");
  await expect(viz.getByText(/^Step 1 of/)).toBeVisible();

  // Play runs through the steps by itself and stops at the end.
  await viz.getByRole("button", { name: "4×" }).click();
  await viz.getByRole("button", { name: "Play" }).click();
  await expect(viz.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(viz.getByRole("button", { name: "Next step" })).toBeDisabled({ timeout: 30_000 });
  await expect(viz.getByRole("button", { name: "Play" })).toBeVisible();
  await expect(happened).toContainText("Program finished");
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
  await viz.getByRole("button", { name: "memory" }).click();
  const happened = viz.getByLabel("What happened");
  const next = viz.getByRole("button", { name: "Next step" });
  while (!((await happened.textContent()) ?? "").includes("Swapped")) await next.click();
  await expect(happened).toContainText("Swapped arr[0] and arr[1]");
  const list = viz.getByRole("group", { name: "list object" });
  await expect(list.locator("[data-cell]")).toHaveText(["1", "3"]);
  // `i` points at element 0 of arr.
  await expect(list.getByText("i", { exact: true })).toBeVisible();
  // The changed cells flash.
  await expect(list.locator(".cw-viz-changed")).toHaveCount(2);

  await viz.getByRole("button", { name: "Last step" }).click();
  const nodes = viz.getByRole("group", { name: "Node object" });
  await expect(nodes).toHaveCount(2);
  // A linked list reads left to right: the second node sits beside the first.
  // Cards glide into place: measure once they have settled.
  await expect
    .poll(async () => {
      const [a, b] = [await nodes.nth(0).boundingBox(), await nodes.nth(1).boundingBox()];
      return !!a && !!b && b.x > a.x + a.width && Math.abs(b.y - a.y) < 4;
    })
    .toBe(true);
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
  await viz.getByRole("button", { name: "memory" }).click();
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByLabel("Output so far")).toHaveText("1");
  const objects = viz.getByRole("region", { name: "Objects" });
  await expect(objects.getByRole("group", { name: "ArrayList object" })).toContainText("4");
  await expect(objects.getByRole("group", { name: "Box object" })).toContainText("items");
  // The view explains itself: which call runs, who points at each object, and no empty `args`.
  const frames = viz.getByRole("region", { name: "Frames" });
  await expect(frames.getByRole("group", { name: "Frame Main.main" })).toContainText(/Running|Returning/);
  await expect(frames.getByRole("row", { name: /^args/ })).toHaveCount(0);
  await expect(objects.getByRole("group", { name: "ArrayList object" })).toContainText("xs");
  await expect(viz.getByRole("note", { name: "How to read this view" })).toBeVisible();
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
  await expect(viz.getByRole("button", { name: "structures" })).toHaveAttribute("aria-pressed", "true");
  await viz.getByRole("button", { name: "Last step" }).click();
  await expect(viz.getByRole("region", { name: "Binary search tree root" })).toContainText("10");
  await expect(viz.getByRole("region", { name: "Stack stack" })).toContainText("Top");
  await expect(viz.getByRole("region", { name: "Queue queue" })).toContainText("5");
  await expect(viz.getByRole("region", { name: "Queue queue" })).not.toContainText("4");
  await expect(viz.getByRole("region", { name: "Graph graph" })).toContainText("visited (1)");
  await expect(viz.getByRole("region", { name: "Hash map freq" })).toContainText("'a'");
  // The memory view is one click away.
  await viz.getByRole("button", { name: "memory" }).click();
  await expect(viz.getByRole("region", { name: "Objects" })).toBeVisible();
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
  await viz.getByRole("button", { name: "memory" }).click();
  await expect(viz.getByRole("region", { name: "Frames" }).getByRole("group", { name: "Frame <module>" })).toContainText("Global");
});
