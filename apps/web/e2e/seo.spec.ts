import { expect, test } from "@playwright/test";

/** Landing pages are real pages with content, and their button opens the editor in that language. */
test("a compiler landing page opens the editor with a new project in its language", async ({ page }) => {
  await page.goto("/python-online-compiler");
  await expect(page).toHaveTitle(/Online Python Compiler/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Online Python compiler");
  await expect(page.getByText("Which Python version is used?")).toBeVisible();
  await page.getByRole("link", { name: "Open the Python compiler" }).first().click();
  await expect(page.getByRole("button", { name: "Project: Python project" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello");
  // The address is clean again, so a reload does not create another project.
  expect(new URL(page.url()).search).toBe("");
});

test("every landing page links to the others, and the start screen links to them", async ({ page }) => {
  await page.goto("/online-debugger");
  const links = page.getByRole("region").or(page.locator("section")).getByRole("link", { name: /Online Java compiler/ });
  await expect(links.first()).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Compilers and tools" }).getByRole("link", { name: "Online Java compiler" })).toBeVisible();
});
