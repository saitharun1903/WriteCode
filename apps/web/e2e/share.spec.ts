import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import jsQR from "jsqr";

/**
 * Code as a PDF, code shared by link, and projects moved to another browser
 * by scanning a code. The link and the transfer need the API; nothing here
 * runs a program.
 */
test.setTimeout(120_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const CODE = 'def greet(name):\n    return f"Hello, {name}!"  # a greeting\n\n\nprint(greet("Asha"))\n';

async function fresh(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
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

async function projectWithCode(page: Page) {
  await page.getByRole("button", { name: "New Python project" }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editor(page)).toContainText("Hello World");
  await editor(page).click();
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, CODE);
  await expect(editor(page)).toContainText("greet");
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

/** Reads a QR code the way a camera would: the picture's pixels, through a QR reader. */
async function scan(code: Locator): Promise<string | undefined> {
  const { pixels, side } = await code.evaluate(async (el) => {
    const svg = el.querySelector("svg")!;
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = 600;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, side, side);
    URL.revokeObjectURL(url);
    return { pixels: Array.from(ctx.getImageData(0, 0, side, side).data), side };
  });
  return jsQR(Uint8ClampedArray.from(pixels), side, side)?.data;
}

test("a new project asks for its name before it opens", async ({ browser }) => {
  const page = await fresh(browser);
  await page.getByRole("button", { name: "New C++ project" }).click();
  const dialog = page.getByRole("dialog", { name: "New C++ project" });
  const name = dialog.getByRole("textbox", { name: "Project name" });
  // A name is suggested; nothing is made until it is confirmed.
  await expect(name).toHaveValue("C++ project");
  await expect(editor(page)).toHaveCount(0);
  await name.fill("   ");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await name.fill("Sorting practice");
  await name.press("Enter");
  await expect(editor(page)).toContainText("Hello World");
  await expect(page.getByRole("button", { name: "Sorting practice" }).first()).toBeVisible();

  // Cancelling makes nothing.
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "New Java project" }).click();
  await page.getByRole("dialog", { name: "New Java project" }).getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "New project" })).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
});

test("a download asks which files and which format, and makes one file", async ({ browser }) => {
  const page = await fresh(browser);
  await projectWithCode(page);
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("notes.py");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /notes\.py/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue("# only notes\nLIMIT = 3\n");
  });
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });

  await page.getByRole("button", { name: "Download and share" }).click();
  await page.getByRole("menuitem", { name: "Download code…" }).click();
  const dialog = page.getByRole("dialog", { name: "Download code" });
  const files = dialog.getByRole("list", { name: "Files to include" });
  await expect(files.getByRole("checkbox")).toHaveCount(2);
  await expect(dialog.getByText("2 files, 7 lines, in one PDF file.")).toBeVisible();

  // Everything, as text: both files in one file, and only their code.
  await dialog.getByRole("radio", { name: /Text/ }).click();
  let [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("Python-project.txt");
  let text = await readFile((await download.path())!, "utf8");
  expect(text).toContain("===== main.py =====");
  expect(text).toContain("===== notes.py =====");
  expect(text).toContain("LIMIT = 3");
  // Only the code: no title, date or product name.
  expect(text).not.toContain("WriteCode");
  expect(text).not.toContain("Python project");
  await expect(dialog).toHaveCount(0);

  // Only the open file, as a Word document.
  await page.getByRole("button", { name: "Download and share" }).click();
  await page.getByRole("menuitem", { name: "Download code…" }).click();
  await dialog.getByRole("button", { name: "Only the open file" }).click();
  await expect(files.getByRole("checkbox", { checked: true })).toHaveCount(1);
  await dialog.getByRole("radio", { name: /Word/ }).click();
  await expect(dialog.getByText("1 file, 2 lines, in one Word file.")).toBeVisible();
  [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("Python-project.doc");
  text = await readFile((await download.path())!, "utf8");
  expect(text).toContain("notes.py");
  expect(text).toContain("LIMIT");
  expect(text).not.toContain("greet");
  expect(text).toContain("writecode.in");

  // Nothing chosen: nothing to download.
  await page.getByRole("button", { name: "Download and share" }).click();
  await page.getByRole("menuitem", { name: "Download code…" }).click();
  await files.getByRole("checkbox").first().uncheck();
  await files.getByRole("checkbox").last().uncheck();
  await expect(dialog.getByRole("button", { name: "Download", exact: true })).toBeDisabled();
  await expect(dialog.getByText("Choose at least one file.")).toBeVisible();
});

test("the code downloads as a PDF with every line and the product's name", async ({ browser }) => {
  const page = await fresh(browser);
  await projectWithCode(page);
  await page.getByRole("button", { name: "Download and share" }).click();
  await page.getByRole("menuitem", { name: "Download code…" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog", { name: "Download code" }).getByRole("button", { name: "Download", exact: true }).click()]);
  expect(download.suggestedFilename()).toBe("Python-project.pdf");
  const pdf = await readFile((await download.path())!, "latin1");
  expect(pdf.startsWith("%PDF-1.4")).toBe(true);
  for (const text of ["Python project", "(main.py)", "(def)", "greet", '"Hello, {name}!"', "# a greeting", "(WriteCode)", "writecode.in", "Page 1 of 1", "/Subtype /Image"]) expect(pdf).toContain(text);
});

test("a share link shows the code to anyone, who can open a copy of their own", async ({ browser }) => {
  const page = await fresh(browser);
  await projectWithCode(page);
  await page.getByRole("button", { name: "Download and share" }).click();
  await page.getByRole("menuitem", { name: /Share a link/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share this code" });
  const link = (await dialog.locator("span[title^='http']").getAttribute("title", { timeout: 20_000 }))!;
  expect(link).toMatch(/\/share#[A-Za-z0-9_-]{16}$/);
  // The code to scan is the same link, and the Copy button copies it.
  await expect.poll(() => scan(dialog.locator("[data-qr]")), { timeout: 15_000 }).toBe(link);
  await dialog.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // Someone else opens it: the code is there, coloured, with the product's name under it.
  const visitor = await fresh(browser);
  await visitor.goto(link);
  await expect(visitor.getByRole("heading", { name: "Python project" })).toBeVisible({ timeout: 20_000 });
  const code = visitor.getByLabel("Code of main.py");
  await expect(code).toContainText('return f"Hello, {name}!"  # a greeting');
  await expect(code.locator(".cw-tok-keyword").first()).toHaveText("def");
  await expect(code.locator(".cw-tok-comment")).toHaveText("# a greeting");
  await expect(visitor.getByRole("contentinfo")).toContainText("WriteCode");
  await expect(visitor.getByRole("contentinfo")).toContainText("writecode.in");
  // A later edit by the owner is not in the link: it is a copy of that moment.
  // The visitor takes a copy of their own into the editor.
  await visitor.getByRole("button", { name: "Open in editor" }).click();
  await expect(editor(visitor)).toContainText('print(greet("Asha"))', { timeout: 30_000 });
  await expect(visitor.getByRole("button", { name: "Project: Python project" })).toBeVisible();
  await visitor.getByRole("button", { name: "Home" }).click();
  await expect(visitor.getByRole("list", { name: "Recent projects" }).getByRole("listitem")).toHaveCount(1);

  // A link that does not exist says so.
  await visitor.goto("/share#AAAAAAAAAAAAAAAA");
  await expect(visitor.getByRole("heading", { name: "This code is not available" })).toBeVisible();
});

test("a project of several files asks which of them the link shows", async ({ browser }) => {
  const page = await fresh(browser);
  await projectWithCode(page);
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("notes.py");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /notes\.py/ })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue("# only notes\nLIMIT = 3\n");
  });
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });

  await page.getByRole("button", { name: "Download and share" }).click();
  await page.getByRole("menuitem", { name: /Share a link/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share this code" });
  const files = dialog.getByRole("list", { name: "Files to include" });
  // No link is made until the files are chosen.
  await expect(files.getByRole("checkbox", { checked: true })).toHaveCount(2);
  await expect(dialog.locator("span[title^='http']")).toHaveCount(0);
  await files.getByRole("checkbox").first().uncheck();
  await files.getByRole("checkbox").last().uncheck();
  await expect(dialog.getByRole("button", { name: "Create link" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Only the open file" }).click();
  await expect(dialog.getByText("The link will show 1 file, 2 lines.")).toBeVisible();
  await dialog.getByRole("button", { name: "Create link" }).click();
  const link = (await dialog.locator("span[title^='http']").getAttribute("title", { timeout: 20_000 }))!;

  // The visitor gets the chosen file and nothing else.
  const visitor = await fresh(browser);
  await visitor.goto(link);
  await expect(visitor.getByRole("heading", { name: "Python project" })).toBeVisible({ timeout: 20_000 });
  await expect(visitor.getByLabel("Code of notes.py")).toContainText("LIMIT = 3");
  await expect(visitor.getByText("main.py")).toHaveCount(0);
  await expect(visitor.getByText("greet")).toHaveCount(0);
});

test("projects move to another browser by scanning a code", async ({ browser }) => {
  const page = await fresh(browser);
  await projectWithCode(page);
  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "Move to another device" }).click();
  const dialog = page.getByRole("dialog", { name: "Move projects to another device" });
  const code = dialog.locator("[data-qr]");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(dialog).toContainText("1 project");
  // What a phone's camera reads from the code is the link.
  let link: string | undefined;
  await expect.poll(async () => (link = await scan(code)), { timeout: 15_000 }).toMatch(/\/get#[A-Za-z0-9_-]{24}$/);
  expect(await dialog.locator("span[title^='http']").getAttribute("title")).toBe(link);

  // The other device opens the link: the project is there at once.
  const other = await fresh(browser);
  await other.goto(link!);
  await expect(other.getByRole("heading", { name: "1 project is now on this device" })).toBeVisible({ timeout: 20_000 });
  await expect(other.getByRole("list", { name: "Projects" })).toContainText("Python project");
  await other.getByRole("link", { name: "Open my projects" }).click();
  const recent = other.getByRole("list", { name: "Recent projects" }).getByRole("listitem");
  await expect(recent).toHaveCount(1);
  await recent.getByRole("button", { name: /Python project/ }).first().click();
  await expect(editor(other)).toContainText('print(greet("Asha"))');

  // Scanning again brings nothing twice.
  await other.goto("/");
  await other.goto(link!);
  await expect(other.getByRole("heading", { name: "Your projects are already here" })).toBeVisible({ timeout: 20_000 });
});
