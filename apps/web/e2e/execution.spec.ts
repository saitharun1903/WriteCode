import { expect, test, type Page } from "@playwright/test";

/**
 * Real end-to-end execution: browser → API → queue → Docker sandbox → back.
 * Requires the full stack (`pnpm setup && pnpm dev`). Run with E2E_EXECUTION=1.
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(180_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const output = (page: Page) => page.getByRole("log", { name: "Program output" });

/** Waits until autosave has written the project to IndexedDB (works against production builds too). */
async function waitSaved(page: Page) {
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

async function freshProject(page: Page, button: RegExp) {
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
  await page.getByRole("button", { name: button }).click();
  await expect(editor(page)).toContainText("Hello World");
}

/**
 * Replaces the active file's content through Monaco's model API. This goes
 * through the same change listener as typing, without auto-indent and
 * auto-closing rewriting the code under test.
 */
async function replaceCode(page: Page, code: string) {
  await editor(page).click();
  await page.evaluate((text) => {
    const monaco = (window as unknown as { monaco: { editor: { getEditors(): { hasTextFocus(): boolean; getModel(): { setValue(v: string): void } }[] } } }).monaco;
    const ed = monaco.editor.getEditors().find((e) => e.hasTextFocus()) ?? monaco.editor.getEditors()[0]!;
    ed.getModel().setValue(text);
  }, code);
  await waitSaved(page);
}

async function run(page: Page) {
  await page.getByRole("button", { name: "Run program" }).click();
}

test("Java: run, edit, rerun, history, reload and recover", async ({ page }) => {
  await freshProject(page, /New Java project/);
  await run(page);
  await expect(output(page)).toContainText("Hello World", { timeout: 120_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();

  await replaceCode(
    page,
    'public class Main {\n    public static void main(String[] args) {\n        int total = 0;\n        for (int i = 1; i <= 10; i++) total += i;\n        System.out.println("Sum: " + total);\n    }\n}\n',
  );
  await run(page);
  await expect(output(page)).toContainText("Sum: 55", { timeout: 60_000 });

  await page.keyboard.press("Control+Shift+H");
  const runs = page.getByRole("complementary", { name: "Sidebar" }).getByRole("list", { name: /Runs/ }).getByRole("listitem");
  await expect(runs).toHaveCount(2);
  await expect(runs.nth(0)).toContainText("Sum: 55");
  await expect(runs.nth(1)).toContainText("Hello World");

  await page.reload();
  await expect(editor(page)).toContainText("Sum: ");
});

test("Java: compilation errors link to the source line", async ({ page }) => {
  await freshProject(page, /New Java project/);
  await replaceCode(page, 'public class Main {\n    public static void main(String[] args) {\n        int value = 10\n        System.out.println(value);\n    }\n}\n');
  await run(page);
  await expect(page.getByText("Compilation error", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(output(page)).toContainText("';' expected");

  await page.getByRole("button", { name: "Problems" }).click();
  const problem = page.getByRole("button", { name: /';' expected.*Main\.java:3/ });
  await expect(problem).toBeVisible();
  await problem.click();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(/^3:/);
});

test("Python: reads stdin and reports runtime errors", async ({ page }) => {
  await freshProject(page, /New Python project/);
  await replaceCode(page, "name = input()\nprint(f'Hi {name}')\nprint(1 / 0)\n");
  await page.getByRole("button", { name: "Program Input" }).click();
  await page.getByRole("textbox", { name: "Program input (stdin)" }).fill("Ada");
  await run(page);
  await expect(output(page)).toContainText("Hi Ada", { timeout: 60_000 });
  await expect(output(page)).toContainText("ZeroDivisionError");
  await expect(page.getByText("Runtime error", { exact: true })).toBeVisible();
});

test("C++: compiles and runs", async ({ page }) => {
  await freshProject(page, /New C\+\+ project/);
  await run(page);
  await expect(output(page)).toContainText("Hello World", { timeout: 120_000 });
  await expect(page.getByText("Success", { exact: true })).toBeVisible();
});

test("infinite loops hit the time limit", async ({ page }) => {
  await freshProject(page, /New Python project/);
  await replaceCode(page, "while True:\n    pass\n");
  await run(page);
  await expect(page.getByText("Time limit exceeded", { exact: true })).toBeVisible({ timeout: 60_000 });
});

test("sandbox has no network access", async ({ page }) => {
  await freshProject(page, /New Python project/);
  await replaceCode(
    page,
    "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 80), timeout=3)\n    print('NETWORK_OPEN')\nexcept OSError as e:\n    print('NETWORK_BLOCKED', type(e).__name__)\n",
  );
  await run(page);
  await expect(output(page)).toContainText("NETWORK_BLOCKED", { timeout: 60_000 });
  await expect(output(page)).not.toContainText("NETWORK_OPEN");
});

test("run history survives reloads and is private to each browser", async ({ page, browser }) => {
  await freshProject(page, /New Python project/);
  await run(page);
  await expect(output(page)).toContainText("Hello World", { timeout: 60_000 });

  await page.reload();
  await page.keyboard.press("Control+Shift+H");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("list", { name: /Runs/ }).getByRole("listitem")).toHaveCount(1);
  await expect(sidebar).toContainText("Hello World");

  // A different browser profile has its own storage and starts empty.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  await expect(otherPage.getByRole("heading", { name: "New project" })).toBeVisible();
  await expect(otherPage.getByRole("list", { name: "Recent projects" })).toHaveCount(0);
  await other.close();
});

test("history keeps one entry per version of the code: the same code run again only moves to the top", async ({ page }) => {
  await freshProject(page, /New Python project/);
  const runOnce = async (text: string) => {
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(output(page)).toContainText(text, { timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Run program" })).toBeEnabled();
  };
  await replaceCode(page, 'print("first version")');
  await runOnce("first version");
  await runOnce("first version");
  await replaceCode(page, 'print("second version")\nprint("more")');
  await runOnce("second version");
  await runOnce("second version");
  await runOnce("second version");

  await page.keyboard.press("Control+Shift+H");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const rows = sidebar.getByRole("list", { name: /Runs/ }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(sidebar).toContainText("2 versions");
  await expect(rows.nth(0)).toContainText("main.py");
  await expect(rows.nth(0)).toContainText("second version");
  await expect(rows.nth(0)).toContainText("ran 3 times");
  await expect(rows.nth(0)).toContainText("+2 −1 lines in main.py");
  await expect(rows.nth(1)).toContainText("first version");
  await expect(rows.nth(1)).toContainText("ran 2 times");

  // The older version's code can be read, and brought back.
  await rows.nth(1).getByRole("button").click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("Ran 2 times");
  await detail.getByRole("tab", { name: /Code/ }).click();
  await expect(detail).toContainText('print("first version")');
  await detail.getByRole("button", { name: "Restore this code" }).click();
  await expect(editor(page)).toContainText("first version");
  // Running the restored code is still the first version: it moves to the top, nothing is added.
  await runOnce("first version");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("ran 3 times");
  await expect(rows.nth(0)).toContainText("first version");
});
