import { expect, test, type Page } from "@playwright/test";

async function freshStart(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("code-workspace");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();
}

const editorText = (page: Page) => page.locator(".monaco-editor .view-lines").first();

/** Waits until autosave has written the project to IndexedDB (works against production builds too). */
async function waitSaved(page: Page) {
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

test("creates a Java project from the start screen", async ({ page }) => {
  await freshStart(page);
  await expect(page.getByRole("list", { name: "Recent projects" })).toHaveCount(0);
  await page.getByRole("button", { name: /New Java project/ }).click();

  await expect(page.getByRole("tab", { name: /Main\.java/ })).toBeVisible();
  await expect(editorText(page)).toContainText('System.out.println("Hello World");');
  await expect(page.getByRole("treeitem", { name: /Main\.java/ })).toBeVisible();
});

test("edits persist across reload and the project reopens", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Python project/ }).click();
  await expect(editorText(page)).toContainText("Hello World");

  // Monaco may use EditContext instead of a textarea, so focus by clicking the text area.
  await editorText(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n# persisted-marker");
  await expect(editorText(page)).toContainText("# persisted-marker");
  await waitSaved(page);

  await page.reload();
  await expect(editorText(page)).toContainText("# persisted-marker");
});

test("creates, renames and deletes files in the explorer", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New C\+\+ project/ }).click();
  await expect(page.getByRole("treeitem", { name: /main\.cpp/ })).toBeVisible();

  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("util.hpp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /util\.hpp/ })).toBeVisible();

  const item = page.getByRole("treeitem", { name: /util\.hpp/ });
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("math.hpp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: /math\.hpp/ })).toBeVisible();

  await page.getByRole("treeitem", { name: /math\.hpp/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("treeitem", { name: /math\.hpp/ })).toHaveCount(0);
});

test("rejects unsafe file names inline", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("../evil.java");
  await expect(page.getByText(/cannot contain slashes/)).toBeVisible();
});

test("command palette runs commands", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await expect(page.getByRole("tab", { name: /Main\.java/ })).toBeVisible();

  await page.keyboard.press("Control+Shift+P");
  await page.getByPlaceholder("Type a command…").fill("toggle light");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("project search finds matches and navigates", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await page.keyboard.press("Control+Shift+F");
  await page.getByRole("textbox", { name: "Search in project" }).fill("println");
  await expect(page.getByText("1 result in 1 file")).toBeVisible();
});

test("run reports an actionable error when the execution service is down", async ({ page }) => {
  test.skip(!!process.env.E2E_EXECUTION, "execution service is running");
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByText("Execution service unreachable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a project that is only opened is not kept as recent work; an edited one is", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await expect(page.getByRole("tab", { name: /Main\.java/ })).toBeVisible();
  await page.getByRole("button", { name: "Home" }).click();
  await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Recent projects" })).toHaveCount(0);
  // Still gone after a reload: it was discarded, not just hidden.
  await page.reload();
  await expect(page.getByRole("list", { name: "Recent projects" })).toHaveCount(0);

  await page.getByRole("button", { name: /New Python project/ }).click();
  await editorText(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n# my change");
  await waitSaved(page);
  await page.getByRole("button", { name: "Home" }).click();
  const recent = page.getByRole("list", { name: "Recent projects" });
  await expect(recent.getByRole("listitem")).toHaveCount(1);
  await expect(recent).toContainText("Python project");
  await expect(recent).toContainText("Edited just now");
});

/** The whole text of the open file, straight from Monaco's model. */
const modelText = (page: Page) =>
  page.evaluate(() => (window as unknown as { monaco: { editor: { getModels(): { getValue(): string }[] } } }).monaco.editor.getModels()[0]!.getValue());

test("familiar snippets: sout and fori expand as in IntelliJ, with Tab stops", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await expect(editorText(page)).toContainText("Hello World");
  await page.evaluate(() => {
    const ed = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void; focus(): void }[] } } }).monaco.editor.getEditors()[0]!;
    ed.setPosition({ lineNumber: 3, column: 100 });
    ed.focus();
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("fori");
  await expect(page.locator(".suggest-widget")).toContainText("for (int i = 0; i < n; i++)");
  await page.keyboard.press("Enter");
  // First Tab stop is the loop variable, then the bound.
  await page.keyboard.press("Tab");
  await page.keyboard.type("5");
  await page.keyboard.press("Tab");
  await page.keyboard.type("sout");
  await expect(page.locator(".suggest-widget")).toContainText("System.out.println()");
  await page.keyboard.press("Enter");
  await page.keyboard.type("i");
  await expect.poll(() => modelText(page)).toContain("for (int i = 0; i < 5; i++) {");
  await expect.poll(() => modelText(page)).toMatch(/for \(int i = 0; i < 5; i\+\+\) \{\n\s+System\.out\.println\(i\);\n\s+\}/);
});

test("automatic imports: using Scanner adds its import, and Ctrl+Z takes back just the import", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await expect(editorText(page)).toContainText("Hello World");
  await page.evaluate(() => {
    const ed = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void; focus(): void }[] } } }).monaco.editor.getEditors()[0]!;
    ed.setPosition({ lineNumber: 3, column: 100 });
    ed.focus();
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Scanner in = new Scanner(System.in);", { delay: 20 });
  await page.keyboard.press("Escape");
  await expect.poll(() => modelText(page), { timeout: 5000 }).toMatch(/^import java\.util\.Scanner;\n\npublic class Main \{/);
  expect(await modelText(page)).toContain("        Scanner in = new Scanner(System.in);");

  await page.keyboard.press("Control+z");
  await expect.poll(() => modelText(page)).not.toContain("import java.util.Scanner;");
  expect(await modelText(page)).toContain("Scanner in = new Scanner(System.in);");
});

test("import files: review what is added, replaced and skipped, then they are in the project", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await expect(editorText(page)).toContainText("Hello World");

  await page.getByLabel("Choose files to import").setInputFiles([
    { name: "Helper.java", mimeType: "text/x-java", buffer: Buffer.from("public class Helper {\n    static int twice(int x) {\n        return 2 * x;\n    }\n}\n") },
    { name: "Main.java", mimeType: "text/x-java", buffer: Buffer.from('public class Main {\n    public static void main(String[] args) {\n        System.out.println(Helper.twice(21));\n    }\n}\n') },
    { name: "logo.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
  ]);
  const dialog = page.getByRole("dialog", { name: "Import 2 files" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Files to import" })).toContainText("Helper.java");
  await expect(dialog.getByRole("list", { name: "Files to import" }).getByRole("listitem").filter({ hasText: "Main.java" })).toContainText("replaces");
  await expect(dialog.getByRole("list", { name: "Skipped files" })).toContainText("logo.png");
  await dialog.getByRole("button", { name: "Import" }).click();

  await expect(page.getByRole("treeitem", { name: /Helper\.java/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Helper\.java/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("treeitem", { name: /Main\.java/ }).click();
  await expect(editorText(page)).toContainText("Helper.twice(21)");
});

test("dropping files from the desktop onto the Project panel imports them", async ({ page }) => {
  await freshStart(page);
  await page.getByRole("button", { name: /New Python project/ }).click();
  await expect(editorText(page)).toContainText("Hello");
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["def add(a, b):\n    return a + b\n"], "utils.py", { type: "text/x-python" }));
    return dt;
  });
  const tree = page.getByRole("tree", { name: "Project files" });
  await tree.dispatchEvent("dragover", { dataTransfer: data });
  await expect(page.getByText("Drop to import into the project")).toBeVisible();
  await tree.dispatchEvent("drop", { dataTransfer: data });
  const dialog = page.getByRole("dialog", { name: "Import 1 file" });
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(page.getByRole("treeitem", { name: /utils\.py/ })).toBeVisible();
});

test("settings: sections, live font preview, and turning automatic imports off is respected", async ({ page }) => {
  const shots = process.env.E2E_SHOTS;
  await freshStart(page);
  await page.getByRole("button", { name: /New Java project/ }).click();
  await expect(editorText(page)).toContainText("Hello World");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  await dialog.getByRole("button", { name: "Larger" }).click();
  await expect(dialog.getByText("15px")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/settings-appearance.png` });
  await dialog.getByRole("button", { name: "Coding help" }).click();
  if (shots) await page.screenshot({ path: `${shots}/settings-help.png` });
  const auto = dialog.getByRole("switch", { name: "Add imports automatically" });
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await dialog.getByRole("button", { name: "Shortcuts" }).click();
  await dialog.getByRole("textbox", { name: "Search shortcuts" }).fill("run");
  await expect(dialog.getByRole("list", { name: "Keyboard shortcuts" })).toContainText("Run All Tests");
  if (shots) await page.screenshot({ path: `${shots}/settings-shortcuts.png` });
  await dialog.getByRole("button", { name: "Done" }).click();

  await page.evaluate(() => {
    const ed = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void; focus(): void }[] } } }).monaco.editor.getEditors()[0]!;
    ed.setPosition({ lineNumber: 3, column: 100 });
    ed.focus();
  });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Scanner in = new Scanner(System.in);", { delay: 20 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  expect(await modelText(page)).not.toContain("import java.util.Scanner;");
  // The choice is remembered.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Coding help" }).click();
  await expect(page.getByRole("switch", { name: "Add imports automatically" })).toHaveAttribute("aria-checked", "false");
});
