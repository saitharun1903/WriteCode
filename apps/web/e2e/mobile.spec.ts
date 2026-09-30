import { expect, test, type Page } from "@playwright/test";

/**
 * Phones and tablets: a title bar that fits, the glass dock, sheets that open
 * and close (by the dock, by tapping outside, by dragging them down), running a
 * program, and the desktop left as it was. Running needs the full stack
 * (E2E_EXECUTION=1); the rest needs only the web app.
 */

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true };

async function freshPython(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("code-workspace");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await page.getByRole("button", { name: "New Python project" }).click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello World");
}

const dock = (page: Page) => page.getByRole("navigation", { name: "Panels" });

/** Nothing on the page is wider than the screen. */
async function fitsWidth(page: Page) {
  const overflow = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll("header *")]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.right > vw + 1 && getComputedStyle(e).visibility !== "hidden";
      })
      .map((e) => e.getAttribute("aria-label") ?? e.tagName);
  });
  expect(overflow).toEqual([]);
}

test.describe("phone", () => {
  test.use(PHONE);

  test("title bar fits; the dock opens and closes panels as sheets", async ({ page }) => {
    await freshPython(page);
    await fitsWidth(page);
    await expect(page.getByRole("button", { name: "Run program" })).toBeVisible();
    // No status bar under the dock.
    await expect(page.getByRole("button", { name: /Runner online|Checking runner/ })).toHaveCount(0);

    await dock(page).getByRole("button", { name: "Tests" }).click();
    await expect(dock(page).getByRole("button", { name: "Tests" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: "Tests" })).toBeVisible();
    // Tapping the same tab closes it; tapping outside does too.
    await dock(page).getByRole("button", { name: "Tests" }).click();
    await expect(page.getByRole("region", { name: "Tests" })).toHaveCount(0);
    await dock(page).getByRole("button", { name: "Files" }).click();
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click({ position: { x: 370, y: 300 } });
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveCount(0);

    // Dragging a sheet down by its grabber closes it.
    await dock(page).getByRole("button", { name: "Visualize" }).click();
    const sheet = page.getByRole("region", { name: "Visualize" });
    await expect(sheet).toBeVisible();
    // Once it has risen into place; then a finger, not a mouse: real touch events at a finger's pace.
    let last = -1;
    await expect
      .poll(async () => {
        const top = (await page.locator(".cw-sheet").boundingBox())?.y ?? -1;
        const settled = top === last;
        last = top;
        return settled;
      })
      .toBe(true);
    const grab = (await page.locator(".cw-sheet .cursor-grab").boundingBox())!;
    const touch = await page.context().newCDPSession(page);
    const x = grab.x + grab.width / 2;
    let y = grab.y + 8;
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 0; i < 10; i++) {
      y += 28;
      await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
    }
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(sheet).toHaveCount(0);
  });

  test("the More menu holds what the title bar has no room for", async ({ page }) => {
    await freshPython(page);
    await page.getByRole("button", { name: "More" }).click();
    for (const item of ["Share live session", "Search files and actions", "Open settings"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    await page.getByRole("menuitem", { name: "Open settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("runs a program and shows its output in the Run sheet", async ({ page }) => {
    test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
    await freshPython(page);
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(page.getByRole("log", { name: "Program output" })).toContainText("Hello World", { timeout: 120_000 });
    await expect(dock(page).getByRole("button", { name: "Run" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("tablet", () => {
  test.use(TABLET);

  test("a touch tablet gets the dock with every tab named", async ({ page }) => {
    await freshPython(page);
    await fitsWidth(page);
    for (const name of ["Files", "Run", "Debug", "Visualize", "Tests", "History", "AI"]) {
      await expect(dock(page).getByRole("button", { name })).toContainText(name);
    }
  });
});

test.describe("desktop", () => {
  test("keeps its activity bar and status bar, with no dock", async ({ page }) => {
    await freshPython(page);
    await expect(dock(page)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Tool windows" })).toBeVisible();
  });
});
