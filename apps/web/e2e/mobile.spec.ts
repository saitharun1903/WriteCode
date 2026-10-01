import { expect, test, type Page } from "@playwright/test";

/**
 * Phones and tablets: a title bar that fits, the tab bar (a rail on tablets), sheets that open
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
  await page.getByRole("button", { name: "Create", exact: true }).click();
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

  test("the More menu holds what the title bar has no room for; its sections open in place, with no keyboard shortcuts", async ({ page }) => {
    await freshPython(page);
    await page.getByRole("button", { name: "More" }).click();
    const menu = page.getByRole("menu");
    for (const item of ["Share live session", "Search files and actions", "Open settings"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    // A section opens under its own row, inside the menu and inside the screen.
    await page.getByRole("menuitem", { name: "Debug", exact: true }).click();
    const start = page.getByRole("menuitem", { name: "Start Debugging / Continue" });
    await expect(start).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(1);
    const box = (await start.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    // A phone has no F5 to press.
    await expect(menu.locator("kbd")).toHaveCount(0);
    await expect(menu).not.toContainText("F5");

    await page.getByRole("menuitem", { name: "Open settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    // Settings fill the phone's screen, and list no keyboard shortcuts.
    const size = (await settings.boundingBox())!;
    expect(size.width).toBeGreaterThan(380);
    expect(size.height).toBeGreaterThan(780);
    await expect(settings.getByRole("button", { name: "Shortcuts" })).toHaveCount(0);
    await settings.getByRole("button", { name: "Editor", exact: true }).click();
    await expect(settings.getByText("Word wrap", { exact: true }).first()).toBeVisible();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toHaveCount(0);
  });

  test("long lines wrap on a phone, so no code is off the screen", async ({ page }) => {
    await freshPython(page);
    await page.evaluate(() => {
      const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
      m.editor.getEditors()[0]!.getModel().setValue(`print("${"a long line of text ".repeat(8)}")\n`);
    });
    const wide = await page.evaluate(() => {
      const ed = (window as unknown as { monaco: { editor: { getEditors(): { getScrollWidth(): number; getLayoutInfo(): { width: number } }[] } } }).monaco.editor.getEditors()[0]!;
      return ed.getScrollWidth() > ed.getLayoutInfo().width + 1;
    });
    expect(wide).toBe(false);
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

  test("a touch tablet gets a rail of tabs, icons only, panels beside the code, and a More menu without keyboard shortcuts", async ({ page }) => {
    await freshPython(page);
    await fitsWidth(page);
    // Every tab is there by its accessible name; none prints it.
    for (const name of ["Files", "Run", "Debug", "Visualize", "Tests", "History", "AI"]) {
      await expect(dock(page).getByRole("button", { name })).toHaveText("");
    }
    // A tablet has room: the tabs are a rail down the left, and a panel opens under the code, which stays in use (nothing dims it).
    const rail = (await dock(page).boundingBox())!;
    expect(rail.x).toBe(0);
    expect(rail.height).toBeGreaterThan(rail.width * 4);
    await dock(page).getByRole("button", { name: "Tests" }).click();
    await expect(page.getByRole("region", { name: "Tests" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close panel" })).toHaveCount(0);
    await page.locator(".monaco-editor .view-lines").first().click();
    await expect(page.getByRole("region", { name: "Tests" })).toBeVisible();
    await dock(page).getByRole("button", { name: "Tests" }).click();
    await expect(page.getByRole("region", { name: "Tests" })).toHaveCount(0);

    await page.getByRole("button", { name: "More" }).click();
    for (const item of ["Download code…", "Share a link to this code", "Move projects to another device"]) await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Open Settings" })).toBeVisible();
    await expect(page.getByRole("menu").locator("kbd")).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Open Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    // The code font is chosen from a list of names.
    const font = settings.getByRole("combobox", { name: "Code font" });
    await font.selectOption({ label: "Fira Code" });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-code"))).toContain("Fira Code");
    await expect(settings.getByRole("button", { name: "Shortcuts" })).toHaveCount(0);
  });
});

test.describe("desktop", () => {
  test("keeps its activity bar and status bar, with no dock", async ({ page }) => {
    await freshPython(page);
    await expect(dock(page)).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Tool windows" })).toBeVisible();
    // The desktop is as it was: no More menu, shortcuts shown, Settings in a window with its Shortcuts section.
    await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings.getByRole("button", { name: "Shortcuts" })).toBeVisible();
    expect((await settings.boundingBox())!.width).toBeLessThan(800);
  });
});
