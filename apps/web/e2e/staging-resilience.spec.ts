import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

/**
 * Outages against the local staging stack (deploy/README.md): stops and starts
 * its containers, so it only runs when E2E_STAGING_COMPOSE=1 and never
 * against a real deployment.
 */
test.skip(!process.env.E2E_STAGING_COMPOSE, "set E2E_STAGING_COMPOSE=1 to run against the local staging stack");

const compose = (args: string) =>
  execSync(`docker compose --env-file deploy/.env.staging -f deploy/docker-compose.prod.yml ${args}`, { cwd: "../..", stdio: "pipe" });
test.setTimeout(240_000);

async function pythonProject(page: Page, code: string) {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((r) => { const q = indexedDB.deleteDatabase("code-workspace"); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  });
  await page.reload();
  await expect(page.getByText("Runner online")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New Python project" }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello World");
  await page.evaluate((t) => (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco.editor.getEditors()[0].getModel().setValue(t), code);
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

test("worker down: Run reports it instead of spinning", async ({ page }) => {
  await pythonProject(page, "print(1)\n");
  compose("stop worker");
  try {
    await page.waitForTimeout(17_000);
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(page.getByText("Code execution is temporarily unavailable. Please try again in a minute.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Run program" })).toBeEnabled();
  } finally {
    compose("start worker");
  }
});

test("API restarted mid-run: the UI does not stay on Running", async ({ page }) => {
  await pythonProject(page, "i = 0\nwhile True:\n    i += 1\n");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible({ timeout: 60_000 });
  compose("restart api");
  // Either the stream error, or the final result fetched after reconnecting.
  await expect(page.getByText(/Execution stream interrupted|Time limit exceeded/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Run program" })).toBeEnabled();
});

test("API down: Run says the server cannot be reached", async ({ page }) => {
  await pythonProject(page, "print(1)\n");
  compose("stop api");
  try {
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(page.getByText("Execution service unreachable")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("The server could not be reached. Check your connection and try again.")).toBeVisible();
  } finally {
    compose("start api");
  }
});
