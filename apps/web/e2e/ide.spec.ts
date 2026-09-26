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
