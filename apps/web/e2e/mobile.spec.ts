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

  for (const size of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
    test(`debugging on a ${size.width}x${size.height} phone: the paused line is in view above the sheet, with the call stack above the variables`, async ({ page }) => {
      test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
      await page.setViewportSize(size);
      await freshPython(page);
      const code = ["def total(nums):", "    s = 0", "    for n in nums:", "        s += n", "    return s", "", "", "", "", "", "", "", "print(total([4, 8, 15]))", ""].join("\n");
      await page.evaluate((text) => {
        const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
        m.editor.getEditors()[0]!.getModel().setValue(text);
      }, code);
      await page.locator(".monaco-editor .view-lines").first().click();
      await page.evaluate(() => {
        const ed = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: { lineNumber: number; column: number }): void; focus(): void }[] } } }).monaco.editor.getEditors()[0]!;
        ed.focus();
        ed.setPosition({ lineNumber: 4, column: 1 });
      });
      await page.keyboard.press("F9");
      await expect(page.locator(".monaco-editor .cw-bp")).toHaveCount(1);
      await page.getByRole("button", { name: "Debug program" }).click();
      const debug = page.getByRole("complementary", { name: "Debugger" });
      await expect(debug.getByText("Paused in")).toBeVisible({ timeout: 120_000 });
      // The line it is paused on is above the sheet, not under it.
      const line = page.locator(".monaco-editor .cw-debug-line").first();
      await expect(line).toBeVisible();
      const sheetTop = (await page.locator(".cw-sheet").boundingBox())!.y;
      const lineBox = (await line.boundingBox())!;
      expect(lineBox.y + lineBox.height).toBeLessThanOrEqual(sheetTop);
      expect(lineBox.y).toBeGreaterThan((await page.locator(".monaco-editor").first().boundingBox())!.y - 1);
      // The call stack is above the variables, each the panel's full width.
      const stack = (await debug.getByRole("list", { name: "Call stack" }).boundingBox())!;
      const vars = (await debug.getByRole("tree", { name: "Variables" }).boundingBox())!;
      expect(vars.y).toBeGreaterThan(stack.y);
      expect(Math.abs(vars.x - stack.x)).toBeLessThan(24);
      await expect(debug.getByRole("treeitem", { name: /^n = 4/ })).toBeVisible();
    });
  }
});

const PORTRAIT_TABLET = { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true };

for (const [device, size] of [
  ["phone", PHONE],
  ["portrait tablet", PORTRAIT_TABLET],
] as const) {
  test.describe(`${device} layout`, () => {
    test.use(size);

    test(`${device}: the New Project dialog fits the screen, with every language and the Create button in it`, async ({ page }) => {
      await page.goto("/");
      const dialog = page.getByRole("dialog", { name: "New Project" });
      // The button is on the page before the app has started; tap again until it answers.
      await expect(async () => {
        await page.getByRole("button", { name: "Custom…" }).click();
        await expect(dialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      const box = (await dialog.boundingBox())!;
      const { width, height } = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(height);
      // Each language sits inside the dialog, none cut at its sides.
      for (const radio of await dialog.getByRole("radio").all()) {
        const r = (await radio.boundingBox())!;
        expect(r.x).toBeGreaterThanOrEqual(box.x);
        expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width);
      }
      await dialog.getByRole("radio", { name: /Rust/ }).scrollIntoViewIfNeeded();
      await dialog.getByRole("radio", { name: /Rust/ }).click();
      await expect(dialog.getByRole("textbox", { name: "Project name" })).toHaveAttribute("placeholder", "Rust project");
      await expect(dialog.getByRole("button", { name: "Create" })).toBeInViewport();
    });

    test(`${device}: the cards on the home page stay at the top while the next one slides over them`, async ({ page }) => {
      await page.goto("/");
      const cards = page.locator("#about > ol > li");
      await expect(cards).toHaveCount(5);
      await cards.nth(0).scrollIntoViewIfNeeded();
      const scroller = page.locator("#about").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");
      const tops = async () => Promise.all([0, 1].map(async (i) => Math.round((await cards.nth(i).boundingBox())!.y)));
      await scroller.evaluate((el) => (el.scrollTop += document.getElementById("about")!.getBoundingClientRect().top));
      await scroller.evaluate((el) => (el.scrollTop += 300));
      const [first] = await tops();
      await scroller.evaluate((el) => (el.scrollTop += 300));
      const [still, second] = await tops();
      // The first card has not moved; the second has come up over it.
      expect(still).toBe(first);
      expect(second).toBeLessThan(first + 200);
      // A whole card fits under what stays at the top of the page.
      const card = (await cards.nth(0).locator("article").boundingBox())!;
      expect(card.y + card.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    });

    test(`${device}: the project's name can be read in the title bar`, async ({ page }) => {
      await freshPython(page);
      await fitsWidth(page);
      const name = page.getByRole("button", { name: "Project: Python project" });
      expect((await name.boundingBox())!.width).toBeGreaterThan(device === "phone" ? 60 : 90);
    });
  });
}

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
