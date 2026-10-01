import { expect, test, type Page } from "@playwright/test";

/**
 * The AI assistant against the real API and Google Gemini. Uses the server's
 * GEMINI_API_KEY and counts against its quota, so it only runs with
 * E2E_ASSISTANT=1 (and the full stack, E2E_EXECUTION=1).
 */
test.skip(!process.env.E2E_EXECUTION || !process.env.E2E_ASSISTANT, "set E2E_EXECUTION=1 and E2E_ASSISTANT=1 with a Gemini key on the API");
test.setTimeout(240_000);

const BUGGY = `import java.util.*;

public class Main {
    public static void main(String[] args) {
        List<Integer> marks = new ArrayList<>();
        marks.add(90);
        marks.add(75);
        int total = 0;
        for (int i = 0; i <= marks.size(); i++) {
            total += marks.get(i);
        }
        System.out.println("Average: " + total / marks.size());
    }
}
`;

async function project(page: Page, language: "Java" | "Python", code: string) {
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
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello World");
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

async function waitForAnswer(page: Page) {
  const panel = page.getByRole("region", { name: "AI Assistant" });
  await expect(panel.getByRole("button", { name: "Send question" })).toBeVisible({ timeout: 180_000 });
  const log = panel.getByRole("log", { name: "Conversation" });
  await expect(log.getByRole("alert")).toHaveCount(0);
  return log;
}

test("fixes a failed run from its real output by editing the right line", async ({ page }) => {
  await project(page, "Java", BUGGY);
  await page.getByRole("button", { name: "Run program" }).click();
  await page.getByRole("button", { name: "Fix with AI" }).click();
  const panel = page.getByRole("region", { name: "AI Assistant" });
  // The panel says what it can see before anything is sent.
  await expect(panel.getByLabel("Shared with the assistant")).toContainText("last run: runtime error");
  const log = await waitForAnswer(page);
  await expect(log).toContainText("line 9");
  await expect(log).toContainText("i < marks.size()");

  // The fix is an edit of line 9 itself (not a paste at the cursor): Apply replaces exactly that line.
  await page.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void }[] } } }).monaco;
    m.editor.getEditors()[0]!.setPosition({ lineNumber: 3, column: 1 });
  });
  const card = log.getByRole("group", { name: "Suggested change to Main.java" }).last();
  await card.getByRole("button", { name: "Apply fix" }).click();
  await expect(log.getByText("Applied")).toBeVisible();
  const code = await page.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { getValue(): string } }[] } } }).monaco;
    return m.editor.getEditors()[0]!.getModel().getValue();
  });
  expect(code.split("\n")[8]).toContain("i < marks.size()");
  expect(code.split("\n").length).toBe(BUGGY.split("\n").length);
  expect(code.split("\n")[2]).toBe("public class Main {");
  // Run again straight from the card: no more exception.
  await log.getByRole("button", { name: "Run again" }).click();
  await expect(page.getByRole("log", { name: "Program output" })).toContainText("Average:", { timeout: 90_000 });

  // Follow-ups keep the conversation.
  await panel.getByLabel("Ask the assistant").fill("Is the average printed correctly after that fix?");
  await page.keyboard.press("Enter");
  await waitForAnswer(page);
  await expect(log).toContainText(/integer division|82\.5|double/i);
});

test("explains a visualizer step from the recorded values", async ({ page }) => {
  await project(page, "Python", "nums = [5, 2]\nnums[0], nums[1] = nums[1], nums[0]\nprint(nums)\n");
  await page.getByRole("button", { name: "Visualize execution" }).click();
  const viz = page.getByRole("region", { name: "Visualize" });
  await expect(viz.getByText(/^Step 1 of \d+$/)).toBeVisible({ timeout: 120_000 });
  const next = viz.getByRole("button", { name: "Next step" });
  while (!((await viz.getByLabel("What happened").textContent()) ?? "").includes("Swapped")) await next.click();
  await viz.getByRole("button", { name: "Explain this step" }).click();
  await expect(page.getByRole("region", { name: "AI Assistant" }).getByLabel("Shared with the assistant")).toContainText("visualizer step");
  const log = await waitForAnswer(page);
  await expect(log).toContainText(/swap/i);
  await expect(log).toContainText("[2, 5]");
});
