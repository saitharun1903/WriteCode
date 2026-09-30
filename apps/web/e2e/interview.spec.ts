import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Interview mode with two real browsers: the interviewer prepares the problem
 * and hidden tests; the candidate agrees to the rules, codes with the compiler
 * only, and everything they do reaches the interviewer.
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(240_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const output = (page: Page) => page.getByRole("log", { name: "Program output" });
const panel = (page: Page) => page.getByRole("region", { name: "Interview" });

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
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
  return page;
}

async function setCode(page: Page, code: string) {
  // Monaco loads in the background; wait until the editor exists.
  await page.waitForFunction(() => ((window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors().length ?? 0) > 0, null, { timeout: 30_000 });
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
}

test("a full interview: setup, consent, restricted candidate, live activity, hidden tests, notes, replay, report, end", async ({ browser }) => {
  // ---- The interviewer prepares the interview.
  const hr = await freshPage(browser);
  await hr.getByRole("button", { name: /Start a coding interview/ }).click();
  const setup = hr.getByRole("dialog", { name: "Start a coding interview" });
  await setup.getByPlaceholder("e.g. Priya (HR)").fill("Meera");
  await setup.getByRole("combobox", { name: "Language" }).selectOption("python");
  await setup.getByRole("combobox", { name: "Duration" }).selectOption("30");
  await setup.getByPlaceholder(/Find the two numbers/).fill("Double it");
  await setup.getByRole("textbox", { name: /Problem statement/ }).fill("Read a number n and print 2n.");
  await setup.getByRole("button", { name: "Add sample test" }).click();
  await setup.getByRole("textbox", { name: "Sample tests 1 input" }).fill("2");
  await setup.getByRole("textbox", { name: "Sample tests 1 expected output" }).fill("4");
  await setup.getByRole("button", { name: "Add hidden test" }).click();
  await setup.getByRole("textbox", { name: "Hidden tests 1 input" }).fill("5");
  await setup.getByRole("textbox", { name: "Hidden tests 1 expected output" }).fill("10");
  await setup.getByRole("button", { name: "Add hidden test" }).click();
  await setup.getByRole("textbox", { name: "Hidden tests 2 input" }).fill("3000");
  await setup.getByRole("textbox", { name: "Hidden tests 2 expected output" }).fill("6000");
  await setup.getByRole("button", { name: "Create interview" }).click();

  await expect(panel(hr).getByText("Waiting for the candidate to open the link")).toBeVisible({ timeout: 20_000 });
  const link = (await panel(hr).locator("span[title^='http']").getAttribute("title"))!;
  expect(link).toMatch(/\/live#/);

  // ---- The candidate joins and must agree to the rules first.
  const cand = await freshPage(browser);
  await cand.goto(link);
  await cand.getByRole("dialog", { name: "Join live session" }).getByPlaceholder("e.g. Priya").fill("Asha");
  await cand.getByRole("button", { name: "Join" }).click();
  const rules = cand.getByRole("dialog", { name: "Coding interview" });
  await expect(rules).toContainText("anything you paste into the page");
  await expect(hr.getByText("Asha")).toBeVisible();
  await expect(panel(hr)).toContainText("30:00 · not started");
  await rules.getByRole("button", { name: /I agree/ }).click();
  await expect(rules).toHaveCount(0);
  // The clock is running for both.
  await expect(panel(hr).getByRole("timer").first()).not.toContainText("not started");
  await expect(cand.getByRole("timer").first()).not.toContainText("not started");

  // Only the compiler and Run: no debugger, visualizer or AI.
  await expect(cand.getByRole("button", { name: "Run program" })).toBeVisible();
  await expect(cand.getByRole("button", { name: "Debug program" })).toHaveCount(0);
  await expect(cand.getByRole("button", { name: "Visualize execution" })).toHaveCount(0);
  await expect(cand.getByRole("button", { name: "AI Assistant" })).toHaveCount(0);
  await expect(panel(cand)).toContainText("Read a number n and print 2n.");
  // The hidden tests never reach the candidate's page.
  expect(await cand.content()).not.toContain("6000");

  // ---- The candidate works; the interviewer sees it all.
  await setCode(cand, "n = int(input())\nprint(n * 2)\n");
  await expect(editor(hr)).toContainText("print(n * 2)");
  await cand.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "print('copied from somewhere')");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await cand.keyboard.press("F5"); // debugger: blocked, nothing happens
  await cand.getByRole("button", { name: "Run program" }).click();
  const input = cand.getByRole("textbox", { name: "Program input" });
  await expect(input).toBeVisible({ timeout: 120_000 });
  await input.fill("21");
  await cand.keyboard.press("Enter");
  await expect(output(cand)).toContainText("42", { timeout: 30_000 });
  await expect(output(hr)).toContainText("42", { timeout: 30_000 });

  await panel(hr).getByRole("tab", { name: /Activity/ }).click();
  const activity = panel(hr).getByRole("list", { name: "Activity" });
  await expect(activity).toContainText("Asha pasted 30 characters");
  await expect(activity).toContainText("copied from somewhere");
  await expect(activity).toContainText("Asha switched to another window");
  await expect(activity).toContainText("Asha's run succeeded", { timeout: 30_000 });

  // Hidden tests run by themselves after the successful run.
  await panel(hr).getByRole("tab", { name: /Hidden tests/ }).click();
  await expect(panel(hr).getByText("2 / 2 passed")).toBeVisible({ timeout: 90_000 });

  // Private notes and rating.
  await panel(hr).getByRole("tab", { name: /Notes/ }).click();
  await panel(hr).getByRole("textbox", { name: "Interviewer notes" }).fill("Solved it quickly; pasted one line.");
  await panel(hr).getByRole("radio", { name: "4 stars" }).click();

  // Replay and the report.
  await panel(hr).getByRole("tab", { name: /Report/ }).click();
  await panel(hr).getByRole("button", { name: "Replay the coding" }).click();
  const replay = hr.getByRole("dialog", { name: "Replay the coding" });
  await expect(replay.getByRole("slider", { name: "Position in the recording" })).toBeVisible({ timeout: 20_000 });
  await replay.getByRole("slider", { name: "Position in the recording" }).fill("0");
  await expect(replay).toContainText("change 0 of");
  await hr.keyboard.press("Escape");
  const [download] = await Promise.all([hr.waitForEvent("download"), panel(hr).getByRole("button", { name: "Download report" }).click()]);
  const html = await readFile((await download.path())!, "utf8");
  expect(html).toContain("Double it");
  expect(html).toContain("Asha");
  expect(html).toContain("2 / 2 passed");
  expect(html).toContain("Solved it quickly");
  expect(html).toContain("★★★★☆");
  expect(html).toContain("print(n * 2)");

  // ---- The interviewer ends it: the candidate's code is locked.
  await panel(hr).getByRole("tab", { name: /Overview/ }).click();
  await panel(hr).getByRole("button", { name: "End interview" }).click();
  await panel(hr).getByRole("button", { name: "End interview" }).last().click();
  await expect(cand.getByText("The interview has ended. Your code has been handed in.").first()).toBeVisible();
  await setCode(cand, "print('changed after the end')\n").catch(() => {});
  await hr.waitForTimeout(800);
  await expect(editor(hr)).not.toContainText("changed after the end");
});

test("the problem and its tests are written from a topic, with answers computed by running them", async ({ browser }) => {
  test.skip(!process.env.E2E_ASSISTANT, "set E2E_ASSISTANT=1 with a Gemini key configured");
  const hr = await freshPage(browser);
  await hr.getByRole("button", { name: /Start a coding interview/ }).click();
  const setup = hr.getByRole("dialog", { name: "Start a coding interview" });
  await setup.getByRole("textbox", { name: "Problem topic" }).fill("sum of the digits of a number");
  await setup.getByRole("radio", { name: "easy" }).click();
  await setup.getByRole("button", { name: "Write problem" }).click();
  await expect(setup.getByRole("list", { name: "Progress" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Write problem" })).toBeVisible({ timeout: 200_000 });
  await expect(setup.getByPlaceholder(/Find the two numbers/)).not.toHaveValue("");
  await expect(setup.getByRole("textbox", { name: /Problem statement/ })).toHaveValue(/Example 1\nInput:/);
  const expected = setup.getByRole("textbox", { name: "Sample tests 1 expected output" });
  await expect(expected).not.toHaveValue("");
  await expect(setup.getByRole("textbox", { name: "Hidden tests 3 expected output" })).not.toHaveValue("");
});
