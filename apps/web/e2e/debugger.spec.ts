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

async function newProject(page: Page, language: "Java" | "Python", code: string) {
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
  await editor(page).click();
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
  await waitSaved(page);
}

const javaProject = (page: Page, code: string) => newProject(page, "Java", code);
const pythonProject = (page: Page, code: string) => newProject(page, "Python", code);

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
