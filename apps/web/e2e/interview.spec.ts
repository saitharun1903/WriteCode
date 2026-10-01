import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Interview mode with two real browsers: the interviewer prepares the problem
 * and hidden tests; the candidate agrees to the rules and works in a locked
 * window (no paste, no suggestions, no other tools), runs the examples and
 * submits against the hidden tests; everything they do reaches the interviewer.
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(240_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
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

/** The interviewer prepares "Double it": one sample test, two hidden ones. Returns the candidate's link. */
async function prepare(hr: Page, leaving?: string): Promise<string> {
  await hr.getByRole("button", { name: "Interview mode" }).click();
  const setup = hr.getByRole("dialog", { name: "Start a coding interview" });
  await setup.getByPlaceholder("e.g. Priya (HR)").fill("Meera");
  await setup.getByRole("combobox", { name: "Language" }).selectOption("python");
  await setup.getByRole("combobox", { name: "Duration" }).selectOption("30");
  await expect(setup.getByRole("combobox", { name: "Leaving the window" })).toHaveValue("3");
  if (leaving) await setup.getByRole("combobox", { name: "Leaving the window" }).selectOption(leaving);
  await setup.getByPlaceholder(/Find the two numbers/).fill("Double it");
  await setup.getByRole("textbox", { name: /Problem statement/ }).fill("Read a number n and print 2n.\n\nExample 1\nInput:\n2\nOutput:\n4");
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
  return link;
}

async function join(browser: Browser, link: string): Promise<Page> {
  const cand = await freshPage(browser);
  await cand.goto(link);
  await cand.getByRole("dialog", { name: "Join live session" }).getByPlaceholder("e.g. Priya").fill("Asha");
  await cand.getByRole("button", { name: "Join" }).click();
  return cand;
}

const tests = (page: Page) => page.getByRole("region", { name: "Tests" });
const code = (page: Page) =>
  page.evaluate(() => (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { getValue(): string } }[] } } }).monaco.editor.getEditors()[0]!.getModel().getValue());

test("a full interview: lockdown, Run on the examples, Submit on the hidden tests, live activity, report, finish", async ({ browser }) => {
  const hr = await freshPage(browser);
  const link = await prepare(hr);

  // ---- The candidate joins and must agree to the rules first.
  const cand = await join(browser, link);
  const rules = cand.getByRole("dialog", { name: "Coding interview" });
  await expect(rules).toContainText("Copying from this page and pasting into it are turned off");
  await expect(rules).toContainText("The 3rd time, the interview ends");
  await expect(hr.getByText("Asha")).toBeVisible();
  await expect(panel(hr)).toContainText("30:00 · not started");
  await rules.getByRole("button", { name: /I agree/ }).click();
  await expect(rules).toHaveCount(0);
  // The clock is running for both.
  await expect(panel(hr).getByRole("timer").first()).not.toContainText("not started");
  await expect(cand.getByRole("timer").first()).not.toContainText("not started");

  // ---- The candidate's desk: the problem, the code, Run and Submit. Nothing else.
  await expect(cand.getByRole("button", { name: "Run program" })).toBeVisible();
  await expect(cand.getByRole("button", { name: "Submit code" })).toBeVisible();
  for (const name of ["Debug program", "Visualize execution", "AI Assistant", "Main menu", "Interview mode"]) await expect(cand.getByRole("button", { name })).toHaveCount(0);
  await expect(cand.getByRole("navigation", { name: "Tool windows" })).toHaveCount(0);
  await expect(panel(cand)).toContainText("Read a number n and print 2n.");
  await expect(panel(cand).getByRole("heading", { name: "Example 1:" })).toBeVisible();
  await expect(tests(cand).getByRole("button", { name: "Case 1" })).toBeVisible();
  await expect(tests(cand)).toContainText("Expected output");
  // The hidden tests never reach the candidate's page.
  expect(await cand.content()).not.toContain("6000");

  // ---- No suggestions, typed or asked for.
  await setCode(cand, "n = int(input())\nprint(n * 2 if n < 100 else 0)\n");
  await expect(editor(hr)).toContainText("print(n * 2 if n < 100 else 0)");
  await editor(cand).click();
  await cand.keyboard.press("Control+End");
  await cand.keyboard.type("pri");
  await cand.keyboard.press("Control+Space");
  await cand.waitForTimeout(700);
  await expect(cand.locator(".suggest-widget.visible")).toHaveCount(0);
  await cand.keyboard.press("Control+Backspace");

  // ---- Nothing from outside can be pasted in, and it is reported.
  await cand.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "print('copied from somewhere')");
    (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(cand.getByText("Pasting is turned off")).toBeVisible();
  expect(await code(cand)).not.toContain("copied from somewhere");
  // The candidate's own code can still be cut and pasted back, without reaching the system clipboard.
  await cand.keyboard.press("Control+Home");
  const copied = await cand.evaluate(() => {
    const target = document.activeElement ?? document.body;
    const cut = new DataTransfer();
    target.dispatchEvent(new ClipboardEvent("cut", { clipboardData: cut, bubbles: true, cancelable: true }));
    const paste = new DataTransfer();
    paste.setData("text/plain", cut.getData("text/plain"));
    const before = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { getValue(): string } }[] } } }).monaco.editor.getEditors()[0]!.getModel().getValue();
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }));
    return { clipboard: cut.getData("text/plain"), before };
  });
  expect(copied.clipboard).toBe("Copying is turned off during this interview.");
  expect(copied.before).toBe("print(n * 2 if n < 100 else 0)\n");
  expect(await code(cand)).toBe("n = int(input())\nprint(n * 2 if n < 100 else 0)\n");

  // ---- Leaving the window covers the code until the candidate comes back.
  await cand.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  const away = cand.getByRole("alertdialog", { name: "You left the interview window" });
  await expect(away).toContainText("You have left 1 of 3 times");
  await away.getByRole("button", { name: "Return to the interview" }).click();
  await expect(away).toHaveCount(0);
  await cand.keyboard.press("F5"); // debugger: blocked, nothing happens

  // ---- Run checks the example; the code is wrong for large numbers, which only Submit finds.
  await tests(cand).getByRole("button", { name: "Add a case of your own" }).click();
  await tests(cand).getByRole("textbox", { name: "Case input" }).fill("21");
  await cand.getByRole("button", { name: "Run program" }).click();
  await expect(tests(cand).getByRole("heading", { name: "Accepted" })).toBeVisible({ timeout: 120_000 });
  await expect(tests(cand)).toContainText("1 / 1 example tests passed");
  await tests(cand).getByRole("button", { name: "Case 2" }).click();
  await expect(tests(cand)).toContainText("42");

  await cand.getByRole("button", { name: "Submit code" }).click();
  await expect(tests(cand).getByRole("heading", { name: "Wrong Answer" })).toBeVisible({ timeout: 120_000 });
  await expect(tests(cand)).toContainText("2 / 3 tests passed · first failed: hidden test 2");
  expect(await cand.content()).not.toContain("6000");

  await panel(hr).getByRole("tab", { name: /Activity/ }).click();
  const activity = panel(hr).getByRole("list", { name: "Activity" });
  await expect(activity).toContainText("Asha tried to paste 30 characters (blocked)");
  await expect(activity).toContainText("copied from somewhere");
  await expect(activity).toContainText("Asha switched to another window");
  await expect(activity).toContainText("Asha's run: 1 / 1 example tests passed", { timeout: 30_000 });
  await expect(activity).toContainText("Asha submitted. Wrong answer: 2 / 3 tests passed");
  await panel(hr).getByRole("tab", { name: /Hidden tests/ }).click();
  await expect(panel(hr).getByText("1 / 2 passed")).toBeVisible({ timeout: 90_000 });

  // ---- Fixed and submitted again.
  await setCode(cand, "n = int(input())\nprint(n * 2)\n");
  await cand.waitForTimeout(3200); // submissions are a few seconds apart
  await cand.getByRole("button", { name: "Submit code" }).click();
  await expect(tests(cand).getByRole("heading", { name: "Accepted" })).toBeVisible({ timeout: 120_000 });
  await expect(tests(cand)).toContainText("3 / 3 tests passed");
  await panel(cand).getByRole("tab", { name: /Submissions/ }).click();
  await expect(panel(cand).getByRole("list", { name: "Submissions" }).getByRole("listitem")).toHaveCount(2);
  await expect(panel(hr).getByText("2 / 2 passed")).toBeVisible({ timeout: 90_000 });
  await panel(hr).getByRole("tab", { name: /Overview/ }).click();
  await expect(panel(hr)).toContainText("Latest submission");
  await expect(panel(hr)).toContainText("3 / 3 tests passed");

  // Private notes and rating.
  await panel(hr).getByRole("tab", { name: /Notes/ }).click();
  await panel(hr).getByRole("textbox", { name: "Interviewer notes" }).fill(`Solved it quickly; pasted one line.
${"Long notes stay connected. ".repeat(250)}`);
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
  expect(html).toContain("Accepted</span> · 3 / 3 tests passed");
  expect(html).toContain("Solved it quickly");
  expect(html).toContain("★★★★☆");
  expect(html).toContain("print(n * 2)");

  // ---- The candidate finishes: the code is locked.
  await tests(cand).getByRole("button", { name: "Finish interview" }).click();
  await tests(cand).getByRole("button", { name: "Yes, finish" }).click();
  await expect(cand.getByText(/The interview has ended \(asha finished\)\. Your code has been handed in\./)).toBeVisible();
  await expect(cand.getByRole("button", { name: "Submit code" })).toBeDisabled();
  await expect(panel(hr).getByRole("timer").first()).toContainText("Ended");
  await setCode(cand, "print('changed after the end')\n").catch(() => {});
  await hr.waitForTimeout(800);
  await expect(editor(hr)).not.toContainText("changed after the end");
});

test("leaving the window too often ends the interview and checks the code that was handed in", async ({ browser }) => {
  const hr = await freshPage(browser);
  const link = await prepare(hr, "1");
  const cand = await join(browser, link);
  const rules = cand.getByRole("dialog", { name: "Coding interview" });
  await expect(rules).toContainText("The first time, the interview ends");
  await rules.getByRole("button", { name: /I agree/ }).click();
  await setCode(cand, "print(int(input()) * 2)\n");
  await expect(editor(hr)).toContainText("print(int(input()) * 2)");
  await cand.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(cand.getByText(/The interview has ended \(asha left the interview window 1 time\)/)).toBeVisible();
  await panel(hr).getByRole("tab", { name: /Activity/ }).click();
  await expect(panel(hr).getByRole("list", { name: "Activity" })).toContainText("The interview ended: Asha left the interview window 1 time");
  // What was handed in is checked without anyone pressing Submit.
  await expect(panel(hr).getByRole("list", { name: "Activity" })).toContainText("The code handed in was checked. Accepted: 3 / 3 tests passed", { timeout: 120_000 });
  await expect(tests(cand).getByRole("heading", { name: "Accepted" })).toBeVisible();
});

test("the problem and its tests are written from a topic, with answers computed by running them", async ({ browser }) => {
  test.skip(!process.env.E2E_ASSISTANT, "set E2E_ASSISTANT=1 with a Gemini key configured");
  const hr = await freshPage(browser);
  await hr.getByRole("button", { name: "Interview mode" }).click();
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
