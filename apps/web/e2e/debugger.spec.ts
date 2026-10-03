import { expect, test, type Page } from "@playwright/test";

/**
 * Debugger end to end: a real JVM paused over JDWP, and a real CPython paused
 * by the tracing adapter, inside the sandbox.
 * Requires the full stack and Docker. Run with E2E_EXECUTION=1.
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(180_000);

const PROGRAM = `public class Main {
    static int square(int x) {
        int r = x * x;
        return r;
    }
    public static void main(String[] args) {
        int[] nums = {3, 1, 2};
        java.util.List<String> names = new java.util.ArrayList<>();
        names.add("ada");
        int total = 0;
        for (int n : nums) {
            total += square(n);
        }
        System.out.println("total=" + total);
    }
}
`;

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const debugPanel = (page: Page) => page.getByRole("complementary", { name: "Debugger" });
const output = (page: Page) => page.getByRole("log", { name: "Program output" });

/** Waits until autosave has written the project to IndexedDB (works against production builds too). */
async function waitSaved(page: Page) {
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

async function newProject(page: Page, language: string, code: string) {
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
  await editor(page).click();
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
  await waitSaved(page);
}

const javaProject = (page: Page, code: string) => newProject(page, "Java", code);
const pythonProject = (page: Page, code: string) => newProject(page, "Python", code);
const rubyProject = (page: Page, code: string) => newProject(page, "Ruby", code);
const rustProject = (page: Page, code: string) => newProject(page, "Rust", code);
const goProject = (page: Page, code: string) => newProject(page, "Go", code);
const phpProject = (page: Page, code: string) => newProject(page, "PHP", code);
const csharpProject = (page: Page, code: string) => newProject(page, "C#", code);
const bashProject = (page: Page, code: string) => newProject(page, "Bash", code);

/** Places the cursor on a line through Monaco's API (no text changes). */
async function cursorTo(page: Page, line: number) {
  await page.evaluate((l) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void; focus(): void }[] } } }).monaco;
    const ed = m.editor.getEditors()[0]!;
    ed.setPosition({ lineNumber: l, column: 1 });
    ed.focus();
  }, line);
}

test("breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await javaProject(page, PROGRAM);

  await cursorTo(page, 12);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".monaco-editor .cw-debug-line")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("12:1");

  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  // Small collections preview their contents, in the tree and next to the code.
  await expect(vars.getByRole("treeitem", { name: "nums = int[3]" })).toContainText("[3, 1, 2]");
  await expect(page.locator(".monaco-editor .cw-inline-value").filter({ hasText: "total = 0" })).toHaveCount(1);
  await expect(page.locator(".monaco-editor .cw-inline-value").filter({ hasText: "nums = [3, 1, 2]" })).toHaveCount(1);
  await vars.getByRole("treeitem", { name: "nums = int[3]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await vars.getByRole("treeitem", { name: /^names = ArrayList/ }).click();
  await expect(vars.getByRole("treeitem", { name: '[0] = "ada"' })).toBeVisible();

  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("n * 10 + total");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("n * 10 + total").locator("..")).toContainText("30");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(panel.getByRole("list", { name: "Call stack" }).getByRole("button", { name: "square:3, Main" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "x = 3" })).toBeVisible();

  await page.keyboard.press("Shift+F11");
  await expect(panel.getByRole("list", { name: "Call stack" }).getByRole("button", { name: /^square:/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();
  // What the program changed since the previous pause, in the panel and in the editor.
  await expect(panel.getByLabel("Changed since the last pause")).toContainText("total 0 → 9");
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toContainText("was 0");
  await expect(page.locator(".monaco-editor .cw-inline-value-changed").filter({ hasText: "total = 9" })).toHaveCount(1);

  // Removing the breakpoint mid-session lets the program run to completion.
  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint Main.java:12" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total=14", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-editor .cw-debug-line")).toHaveCount(0);
});

test("breakpoints persist and follow edits", async ({ page }) => {
  await javaProject(page, PROGRAM);
  await cursorTo(page, 12);
  await page.keyboard.press("F9");
  // Insert two lines above the breakpoint; it should move to line 14.
  await cursorTo(page, 1);
  await page.keyboard.press("End");
  await page.keyboard.insertText("\n// one\n// two");
  await waitSaved(page);
  await page.reload();
  await page.keyboard.press("Control+Shift+D");
  await debugPanel(page).getByRole("button", { name: "View Breakpoints" }).click();
  await expect(page.getByRole("list", { name: "Breakpoints" })).toContainText("Main.java:14");
});

test("pause a running program, then stop it", async ({ page }) => {
  await javaProject(page, "public class Main {\n    public static void main(String[] args) {\n        long i = 0;\n        while (true) {\n            i++;\n        }\n    }\n}\n");
  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Running", { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("toolbar", { name: "Debug controls" }).getByRole("button", { name: "Pause" }).click();
  await expect(panel.getByText("Paused", { exact: true })).toBeVisible();
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: /^i = \d+$/ })).toBeVisible();
  await page.getByRole("toolbar", { name: "Debug controls" }).getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("stops on uncaught exceptions", async ({ page }) => {
  await javaProject(page, 'public class Main {\n    public static void main(String[] args) {\n        int[] a = new int[2];\n        a[5] = 1;\n    }\n}\n');
  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByRole("alert")).toContainText("ArrayIndexOutOfBoundsException");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("4:1");
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
});

const PY_PROGRAM = `class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y


def square(x):
    r = x * x
    return r


def main():
    nums = [3, 1, 2]
    origin = Point(0, 5)
    total = 0
    for n in nums:
        total += square(n)
    print(f"total={total}")


if __name__ == "__main__":
    main()
`;

test("Python: breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await pythonProject(page, PY_PROGRAM);
  await cursorTo(page, 17);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("17:1");
  await expect(panel.getByRole("list", { name: "Call stack" }).getByRole("button", { name: "main:17, main.py" })).toBeVisible();

  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "nums = [3, 1, 2]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "origin = Point(x=0, y=5)" }).click();
  await expect(vars.getByRole("treeitem", { name: "y = 5" })).toBeVisible();

  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("n * 10 + total");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("n * 10 + total").locator("..")).toContainText("30");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(panel.getByRole("list", { name: "Call stack" }).getByRole("button", { name: "square:8, main.py" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "x = 3" })).toBeVisible();

  await page.keyboard.press("Shift+F11");
  await expect(panel.getByRole("list", { name: "Call stack" }).getByRole("button", { name: /^square:/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint main.py:17" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total=14", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("Python: pause a running program, then stop it", async ({ page }) => {
  await pythonProject(page, "i = 0\nwhile True:\n    i += 1\n");
  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Running", { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("toolbar", { name: "Debug controls" }).getByRole("button", { name: "Pause" }).click();
  await expect(panel.getByText("Paused", { exact: true })).toBeVisible();
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: /^i = \d+$/ })).toBeVisible();
  await page.getByRole("toolbar", { name: "Debug controls" }).getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("Python: stops on uncaught exceptions", async ({ page }) => {
  await pythonProject(page, "items = [1, 2]\nprint(items[5])\n");
  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByRole("alert")).toContainText("IndexError: list index out of range");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("2:1");
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(output(page)).toContainText("IndexError");
});

const RUBY_PROGRAM = `class Point
  attr_reader :x, :y

  def initialize(x, y)
    @x = x
    @y = y
  end
end

def square(x)
  r = x * x
  r
end

def main
  nums = [3, 1, 2]
  origin = Point.new(0, 5)
  total = 0
  nums.each do |n|
    total += square(n)
  end
  puts "total=#{total}"
end

main
`;

test("Ruby: breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await rubyProject(page, RUBY_PROGRAM);
  await cursorTo(page, 20);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("20:1");
  // A block is a frame of its own, inside the method that wrote it.
  const stack = panel.getByRole("list", { name: "Call stack" });
  await expect(stack.getByRole("button", { name: "block in main:20, main.rb" })).toBeVisible();
  await expect(stack.getByRole("button", { name: "main:19, main.rb" })).toBeVisible();

  // The block sees its own n and the method's variables around it.
  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "nums = [3, 1, 2]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "origin = #<Point @x=0, @y=5>" }).click();
  await expect(vars.getByRole("treeitem", { name: "@y = 5" })).toBeVisible();

  // Watches are read without running the program's methods: origin.y is the field, not the reader.
  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("n * 10 + total + origin.y");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("n * 10 + total + origin.y").locator("..")).toContainText("35");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(stack.getByRole("button", { name: "square:11, main.rb" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "x = 3" })).toBeVisible();

  // Out of square: the block's next pass, with what the last one added.
  await page.keyboard.press("Shift+F11");
  await expect(stack.getByRole("button", { name: /^square:/ })).toHaveCount(0);
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 1" })).toBeVisible();

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 10" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint main.rb:20" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total=14", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("Ruby: pause a running program, read what the program typed in, and stop on an uncaught exception", async ({ page }) => {
  await rubyProject(page, "i = 0\nloop do\n  i += 1\nend\n");
  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Running", { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("toolbar", { name: "Debug controls" }).getByRole("button", { name: "Pause" }).click();
  await expect(panel.getByText("Paused", { exact: true })).toBeVisible();
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: /^i = \d+$/ })).toBeVisible();
  await page.getByRole("toolbar", { name: "Debug controls" }).getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, 'print "how many? "\nn = gets.to_i\nitems = [1, 2]\nputs items.fetch(n)\n');
  await waitSaved(page);
  await page.getByRole("button", { name: "Debug program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 90_000 });
  await input.fill("5");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("alert")).toContainText("IndexError: index 5 outside of array bounds: -2...2");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("4:1");
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: "n = 5" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(output(page)).toContainText("IndexError");
});

const RUST_PROGRAM = `struct Point {
    x: i32,
    y: i32,
}

fn square(x: i32) -> i32 {
    let r = x * x;
    r
}

fn main() {
    let nums = vec![3, 1, 2];
    let origin = Point { x: 0, y: 5 };
    let mut total = 0;
    for n in &nums {
        total += square(*n);
    }
    println!("total={} {}", total, origin.x);
}
`;

test("Rust: breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await rustProject(page, RUST_PROGRAM);
  await cursorTo(page, 16);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("16:1");
  const stack = panel.getByRole("list", { name: "Call stack" });
  await expect(stack.getByRole("button", { name: "main:16, main.rs" })).toBeVisible();

  // Rust's own names and values: a Vec, a struct, the number a reference points at; not the loop's hidden iterator.
  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: /^iter / })).toHaveCount(0);
  await vars.getByRole("treeitem", { name: "nums = [3, 1, 2]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "origin = {x: 0, y: 5}" }).click();
  await expect(vars.getByRole("treeitem", { name: "y = 5" })).toBeVisible();

  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("*n * 10 + total + origin.y");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("*n * 10 + total + origin.y").locator("..")).toContainText("35");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(stack.getByRole("button", { name: "square:7, main.rs" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "x = 3" })).toBeVisible();

  await page.keyboard.press("Shift+F11");
  await expect(stack.getByRole("button", { name: /^square:/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint main.rs:16" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total=14 0", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("Rust: a panic stops the program where its code panicked, with the message, after typed input", async ({ page }) => {
  await rustProject(page, 'use std::io;\n\nfn main() {\n    let mut line = String::new();\n    io::stdin().read_line(&mut line).unwrap();\n    let n: usize = line.trim().parse().unwrap();\n    let items = vec![1, 2];\n    println!("{}", items[n]);\n}\n');
  await page.getByRole("button", { name: "Debug program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill("5");
  await page.keyboard.press("Enter");
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("alert")).toContainText("panic: index out of bounds: the len is 2 but the index is 5");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("8:1");
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: "n = 5" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(output(page)).toContainText("index out of bounds");
});

const GO_PROGRAM = `package main

import "fmt"

type Point struct {
	X, Y int
}

func square(x int) int {
	r := x * x
	return r
}

func main() {
	nums := []int{3, 1, 2}
	origin := Point{0, 5}
	total := 0
	for _, n := range nums {
		total += square(n)
	}
	fmt.Println("total", total, origin.X)
}
`;

test("Go: breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await goProject(page, GO_PROGRAM);
  await cursorTo(page, 19);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("19:1");
  const stack = panel.getByRole("list", { name: "Call stack" });
  await expect(stack.getByRole("button", { name: "main:19, main.go" })).toBeVisible();

  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "nums = [3, 1, 2]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "origin = {X: 0, Y: 5}" }).click();
  await expect(vars.getByRole("treeitem", { name: "Y = 5" })).toBeVisible();

  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("n*10 + total + origin.Y");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("n*10 + total + origin.Y").locator("..")).toContainText("35");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(stack.getByRole("button", { name: "square:10, main.go" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "x = 3" })).toBeVisible();

  await page.keyboard.press("Shift+F11");
  await expect(stack.getByRole("button", { name: /^square:/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint main.go:19" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total 14 0", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("Go: a panic stops the program where its code panicked, with the message, after typed input", async ({ page }) => {
  await goProject(page, 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar n int\n\tfmt.Scan(&n)\n\titems := []int{1, 2}\n\tfmt.Println(items[n])\n}\n');
  await page.getByRole("button", { name: "Debug program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill("5");
  await page.keyboard.press("Enter");
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("alert")).toContainText("panic: runtime error: index out of range [5] with length 2");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("9:1");
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: "n = 5" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(output(page)).toContainText("index out of range");
});

const PHP_PROGRAM = `<?php
class Point {
    public $x;
    public $y;
    public function __construct($x, $y) { $this->x = $x; $this->y = $y; }
}

function square($x) {
    $r = $x * $x;
    return $r;
}

$nums = [3, 1, 2];
$origin = new Point(0, 5);
$total = 0;
foreach ($nums as $n) {
    $total += square($n);
}
echo "total=$total\n";
`;

test("PHP: breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await phpProject(page, PHP_PROGRAM);
  await cursorTo(page, 17);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("17:1");
  const stack = panel.getByRole("list", { name: "Call stack" });
  await expect(stack.getByRole("button", { name: "<main>:17, main.php" })).toBeVisible();

  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "$total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "$n = 3" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "$nums = [3, 1, 2]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "$origin = Point {x: 0, y: 5}" }).click();
  await expect(vars.getByRole("treeitem", { name: "y = 5" })).toBeVisible();

  // Watches read: a call to the program's own function is refused, arithmetic on its values is not.
  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("$n * 10 + $total + $origin->y");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("$n * 10 + $total + $origin->y").locator("..")).toContainText("35");
  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("square(2)");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("square(2)").locator("..")).toContainText("Watches do not call functions");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(stack.getByRole("button", { name: "square:9, main.php" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "$x = 3" })).toBeVisible();

  // Out of square: PHP reports a foreach line once, so this is the loop's next pass, with what the last one added.
  await page.keyboard.press("Shift+F11");
  await expect(stack.getByRole("button", { name: /^square:/ })).toHaveCount(0);
  await expect(vars.getByRole("treeitem", { name: "$total = 9" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "$n = 1" })).toBeVisible();

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "$total = 10" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint main.php:17" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total=14", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("PHP: an exception stops the program where it is thrown, with its class and message, after typed input", async ({ page }) => {
  await phpProject(page, '<?php\n$n = (int) trim(fgets(STDIN));\n$items = [1, 2];\nif (!isset($items[$n])) {\n    throw new OutOfRangeException("no item $n");\n}\necho $items[$n];\n');
  await page.getByRole("button", { name: "Debug program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill("5");
  await page.keyboard.press("Enter");
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("alert")).toContainText("OutOfRangeException: no item 5");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("5:1");
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: "$n = 5" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(output(page)).toContainText("Uncaught OutOfRangeException");
});

const CSHARP_PROGRAM = `class Point
{
    public int X;
    public int Y;
}

class Program
{
    static int Square(int x)
    {
        int r = x * x;
        return r;
    }

    static void Main()
    {
        var nums = new List<int> { 3, 1, 2 };
        var origin = new Point { X = 0, Y = 5 };
        int total = 0;
        foreach (var n in nums)
        {
            total += Square(n);
        }
        Console.WriteLine($"total {total} {origin.X}");
    }
}
`;

test("C#: breakpoints, variables, watches, stepping and continue", async ({ page }) => {
  await csharpProject(page, CSHARP_PROGRAM);
  await cursorTo(page, 22);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("22:1");
  const stack = panel.getByRole("list", { name: "Call stack" });
  await expect(stack.getByRole("button", { name: "Main:22, Program" })).toBeVisible();

  // A List is shown as its items, not as .NET's internal fields.
  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "nums = [3, 1, 2]" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: /^_items/ })).toHaveCount(0);
  await vars.getByRole("treeitem", { name: "origin = Point {X: 0, Y: 5}" }).click();
  await expect(vars.getByRole("treeitem", { name: "Y = 5" })).toBeVisible();

  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("n * 10 + total + origin.Y");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("n * 10 + total + origin.Y").locator("..")).toContainText("35");
  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("Square(2)");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("Square(2)").locator("..")).toContainText("Watches do not call methods");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(stack.getByRole("button", { name: "Square:11, Program" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "x = 3" })).toBeVisible();

  await page.keyboard.press("Shift+F11");
  await expect(stack.getByRole("button", { name: /^Square:/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint Program.cs:22" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total 14 0", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("C#: an exception stops the program where it is thrown, with its type and message, after typed input", async ({ page }) => {
  await csharpProject(page, "class Program\n{\n    static void Main()\n    {\n        int n = int.Parse(Console.ReadLine());\n        int[] items = { 1, 2 };\n        Console.WriteLine(items[n]);\n    }\n}\n");
  await page.getByRole("button", { name: "Debug program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill("5");
  await page.keyboard.press("Enter");
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("alert")).toContainText("IndexOutOfRangeException: Index was outside the bounds of the array.");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("7:1");
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: "n = 5" })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(output(page)).toContainText("IndexOutOfRangeException");
});

const BASH_PROGRAM = `#!/bin/bash
square() {
  local x=$1
  local r=$((x * x))
  echo "$r"
}

nums=(3 1 2)
total=0
for n in "\${nums[@]}"; do
  total=$((total + $(square "$n")))
done
echo "total=$total"
`;

test("Bash: breakpoints, variables, watches, stepping into a function called in $( ) and continue", async ({ page }) => {
  await bashProject(page, BASH_PROGRAM);
  await cursorTo(page, 11);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);

  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("11:1");
  const stack = panel.getByRole("list", { name: "Call stack" });
  await expect(stack.getByRole("button", { name: "main:11, main.sh" })).toBeVisible();

  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars.getByRole("treeitem", { name: "total = 0" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();
  await vars.getByRole("treeitem", { name: "nums = (3 1 2)" }).click();
  await expect(vars.getByRole("treeitem", { name: "[1] = 1" })).toBeVisible();

  // Watches are read from the variables, without running anything in the script.
  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("n * 10 + total");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("n * 10 + total").locator("..")).toContainText("30");
  await panel.getByRole("textbox", { name: "Add watch expression" }).fill("${nums[2]}");
  await page.keyboard.press("Enter");
  await expect(panel.getByText("${nums[2]}").locator("..")).toContainText("2");

  await page.keyboard.press("F11");
  await expect(panel.getByText("Paused after step")).toBeVisible();
  await expect(stack.getByRole("button", { name: "square:3, main.sh" })).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "n = 3" })).toBeVisible();

  await page.keyboard.press("Shift+F11");
  await expect(stack.getByRole("button", { name: /^square:/ })).toHaveCount(0);

  await page.keyboard.press("F5");
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible();
  await expect(vars.getByRole("treeitem", { name: "total = 9" })).toBeVisible();

  await panel.getByRole("button", { name: "View Breakpoints" }).click();
  await page.getByRole("button", { name: "Remove breakpoint main.sh:11" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("total=14", { timeout: 30_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("Bash: a command that is not found stops the script there, after typed input", async ({ page }) => {
  await bashProject(page, 'read -r name\necho "hi $name"\nnosuchtool --version\necho done\n');
  await page.getByRole("button", { name: "Debug program" }).click();
  const input = page.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill("Ada");
  await page.keyboard.press("Enter");
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on exception")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("alert")).toContainText("command not found: nosuchtool");
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText("3:1");
  await expect(panel.getByRole("tree", { name: "Variables" }).getByRole("treeitem", { name: 'name = "Ada"' })).toBeVisible();
  await page.keyboard.press("F5");
  await expect(output(page)).toContainText("done", { timeout: 15_000 });
});

const LINKED_LIST = `import java.util.Scanner;

public class Main {
    static class Node {
        int value;
        Node next;

        Node(int value) {
            this.value = value;
        }
    }

    static Node reverse(Node head) {
        Node prev = null;
        Node current = head;
        while (current != null) {
            Node next = current.next;
            current.next = prev;
            prev = current;
            current = next;
        }
        return prev;
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        Node head = null;
        Node tail = null;
        for (int i = 0; i < n; i++) {
            Node node = new Node(in.nextInt());
            if (head == null) {
                head = node;
            } else {
                tail.next = node;
            }
            tail = node;
        }
        for (Node p = reverse(head); p != null; p = p.next) {
            System.out.print(p.value + " ");
        }
    }
}
`;

test("Java nested classes appear by their source name (Node, not Main$Node)", async ({ page }) => {
  await javaProject(page, LINKED_LIST);
  await page.getByRole("button", { name: "Program Input" }).click();
  await page.getByRole("textbox", { name: "Program input (stdin)" }).fill("3\n1 2 3");
  await waitSaved(page);
  // current.next = prev;
  await cursorTo(page, 18);
  await page.keyboard.press("F9");
  await page.getByRole("button", { name: "Debug program" }).click();
  const panel = debugPanel(page);
  await expect(panel.getByText("Paused on breakpoint")).toBeVisible({ timeout: 90_000 });
  const vars = panel.getByRole("tree", { name: "Variables" });
  await expect(vars).toContainText("Node");
  await expect(vars).not.toContainText("Main$Node");
});
