import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Live sessions with two real browsers: an owner who shares a project and a
 * guest who joins from the link. Needs the API (live sessions) running; runs
 * need the worker too.
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(180_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const output = (page: Page) => page.getByRole("log", { name: "Program output" });

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
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

/** Owner: a new project shared as "Teacher"; returns the invite link. */
async function startSession(page: Page, language: "Java" | "Python" = "Java"): Promise<string> {
  await page.getByRole("button", { name: new RegExp(`New ${language} project`) }).click();
  await expect(editor(page)).toContainText(language === "Java" ? "Hello World" : "Hello");
  await page.getByRole("button", { name: "Share live session" }).click();
  const dialog = page.getByRole("dialog", { name: "Code together, live" });
  await dialog.getByPlaceholder("e.g. Ravi").fill("Teacher");
  await dialog.getByRole("button", { name: "Start live session" }).click();
  const live = page.getByRole("dialog", { name: "Live session" });
  await expect(live.getByRole("button", { name: "Copy link" })).toBeVisible();
  const link = (await live.locator("span[title^='http']").getAttribute("title"))!;
  expect(link).toMatch(/\/live#[A-Za-z0-9_-]{24}$/);
  await page.keyboard.press("Escape");
  return link;
}

async function joinSession(page: Page, link: string, name: string, shows = "Hello") {
  await page.goto(link);
  const join = page.getByRole("dialog", { name: "Join live session" });
  await join.getByPlaceholder("e.g. Priya").fill(name);
  await join.getByRole("button", { name: "Join" }).click();
  await expect(editor(page)).toContainText(shows);
}

async function setCode(page: Page, code: string) {
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
}

async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

test("share a project live: join from the link, edit together, see cursors, view-only, shared runs, end", async ({ browser }) => {
  const teacher = await freshPage(browser);
  const link = await startSession(teacher);
  await expect(teacher.getByRole("status").filter({ hasText: "Live" })).toContainText("1 person");

  const ravi = await freshPage(browser);
  await joinSession(ravi, link, "Ravi");
  await expect(teacher.getByRole("button", { name: /Live session: 2 people/ })).toBeVisible();
  await expect(ravi.getByRole("status").filter({ hasText: "Live" })).toContainText("2 people");
  // The guest's copy is not saved among their projects unless they ask.
  await expect(ravi.getByRole("button", { name: "Project: Java project" })).toBeVisible();

  // Both edit; each sees the other's change.
  await typeAtEnd(teacher, "\n// from teacher");
  await expect(editor(ravi)).toContainText("// from teacher");
  await typeAtEnd(ravi, "\n// from ravi");
  await expect(editor(teacher)).toContainText("// from ravi");
  // Ravi's cursor shows in the teacher's editor, with his name while he types.
  await expect(teacher.locator(".monaco-editor .cw-live-caret")).toHaveCount(1);
  await expect(teacher.locator(".monaco-editor .cw-live-label")).toHaveCount(1);

  // Undo in a live session takes back only your own change.
  await ravi.keyboard.press("Control+z");
  await expect(editor(teacher)).not.toContainText("// from ravi");
  await expect(editor(ravi)).toContainText("// from teacher");

  // New files appear for everyone.
  await teacher.getByRole("button", { name: "New File" }).click();
  await teacher.keyboard.type("Helper.java");
  await teacher.keyboard.press("Enter");
  await expect(ravi.getByRole("treeitem", { name: /Helper\.java/ })).toBeVisible();

  // View only: the guest can no longer change the code.
  await teacher.getByRole("button", { name: /Live session: 2 people/ }).click();
  const panel = teacher.getByRole("dialog", { name: "Live session" });
  await panel.getByRole("radiogroup", { name: "What Ravi can do" }).getByRole("radio", { name: "View only" }).click();
  await teacher.keyboard.press("Escape");
  await expect(ravi.getByText("View only · Teacher is presenting")).toBeVisible();
  await ravi.getByRole("treeitem", { name: /Main\.java/ }).click();
  await typeAtEnd(ravi, "\n// should not appear");
  await teacher.waitForTimeout(800);
  await expect(editor(teacher)).not.toContainText("should not appear");

  // A run by the teacher shows in Ravi's console as it happens.
  await teacher.getByRole("treeitem", { name: /Main\.java/ }).click();
  await teacher.getByRole("button", { name: "Run program" }).click();
  await expect(output(teacher)).toContainText("Hello World", { timeout: 120_000 });
  await expect(output(ravi)).toContainText("Hello World", { timeout: 30_000 });
  await expect(ravi.getByRole("note")).toContainText("Teacher's run");

  // Ending the session: Ravi can keep a copy.
  await teacher.getByRole("button", { name: /Live session: 2 people/ }).click();
  await teacher.getByRole("button", { name: "End session for everyone" }).click();
  const ended = ravi.getByRole("dialog", { name: "The live session has ended" });
  await expect(ended).toBeVisible();
  await ended.getByRole("button", { name: "Save a copy" }).click();
  await expect(ravi.getByRole("button", { name: "Project: Java project copy" })).toBeVisible();
  await expect(editor(ravi)).toContainText("// from teacher");
  // The teacher keeps the project, with everyone's changes, and is no longer live.
  await expect(teacher.getByRole("button", { name: "Share live session" })).toBeVisible();
  await expect(editor(teacher)).toContainText("// from teacher");
});

test("the owner can remove someone, who cannot rejoin; a reload rejoins the session", async ({ browser }) => {
  const teacher = await freshPage(browser);
  const link = await startSession(teacher);
  const priya = await freshPage(browser);
  await joinSession(priya, link, "Priya");

  // A guest reloading comes back to the same session.
  await priya.reload();
  await priya.getByRole("dialog", { name: "Join live session" }).getByRole("button", { name: "Join" }).click();
  await expect(editor(priya)).toContainText("Hello World");
  await expect(teacher.getByRole("button", { name: /Live session: 2 people/ })).toBeVisible();

  // The owner reloading keeps owning the session.
  await teacher.reload();
  await expect(teacher.getByRole("button", { name: /Live session: 2 people/ })).toBeVisible({ timeout: 15_000 });
  await typeAtEnd(teacher, "\n// after reload");
  await expect(editor(priya)).toContainText("// after reload");

  await teacher.getByRole("button", { name: /Live session: 2 people/ }).click();
  await teacher.getByRole("button", { name: "Remove Priya" }).click();
  await expect(priya.getByRole("dialog", { name: "You were removed from the session" })).toBeVisible();
  await expect(teacher.getByRole("list", { name: "People in this session" }).getByRole("listitem")).toHaveCount(1);
  await teacher.keyboard.press("Escape");
  await expect(teacher.getByRole("button", { name: /Live session: 1 person/ })).toBeVisible();

  await priya.getByRole("dialog", { name: "You were removed from the session" }).getByRole("button", { name: "Close" }).first().click();
  await priya.goto(link);
  await priya.getByRole("dialog", { name: "Join live session" }).getByRole("button", { name: "Join" }).click();
  await expect(priya.getByRole("dialog", { name: "You were removed from the session" })).toBeVisible();
});

test("a broken link explains itself", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.goto("/live#not-a-real-link");
  await expect(page.getByText("This live session link is not complete")).toBeVisible();
  await page.goto("/live#AAAAAAAAAAAAAAAAAAAAAAAA");
  await page.getByRole("dialog", { name: "Join live session" }).getByPlaceholder("e.g. Priya").fill("Someone");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("dialog", { name: "Could not join the live session" })).toContainText("ended or the link is wrong");
});

test("when the owner's debugger pauses, everyone sees the line; the guest can still run their own copy", async ({ browser }) => {
  const teacher = await freshPage(browser);
  const link = await startSession(teacher);
  const ravi = await freshPage(browser);
  await joinSession(ravi, link, "Ravi");

  // Breakpoint on the println line, then debug.
  await teacher.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { setPosition(p: object): void; focus(): void }[] } } }).monaco;
    const ed = m.editor.getEditors()[0]!;
    ed.setPosition({ lineNumber: 3, column: 1 });
    ed.focus();
  });
  await teacher.keyboard.press("F9");
  await teacher.getByRole("button", { name: "Debug program" }).click();
  await expect(teacher.locator(".monaco-editor .cw-debug-line")).toHaveCount(1, { timeout: 90_000 });
  await expect(ravi.locator(".monaco-editor .cw-live-paused")).toHaveCount(1, { timeout: 15_000 });
  // Continue: the program finishes and the highlight goes away for everyone.
  await teacher.keyboard.press("F5");
  await expect(ravi.locator(".monaco-editor .cw-live-paused")).toHaveCount(0, { timeout: 30_000 });

  // The guest runs the shared code on their own; the teacher is not interrupted.
  await ravi.getByRole("button", { name: "Run program" }).click();
  await expect(output(ravi)).toContainText("Hello World", { timeout: 120_000 });
  await expect(ravi.getByRole("note")).toHaveCount(0);
});

test("anyone who can edit can type the input of a program someone else runs", async ({ browser }) => {
  const teacher = await freshPage(browser);
  const link = await startSession(teacher, "Python");
  await setCode(teacher, 'name = input("name? ")\nprint("hi " + name)\n');
  const ravi = await freshPage(browser);
  await joinSession(ravi, link, "Ravi", "input(");

  await teacher.getByRole("button", { name: "Run program" }).click();
  // Ravi sees the program waiting and answers it.
  const box = ravi.getByRole("textbox", { name: "Program input" });
  await expect(box).toBeVisible({ timeout: 120_000 });
  await box.fill("Ravi");
  await ravi.keyboard.press("Enter");
  await expect(output(teacher)).toContainText("hi Ravi", { timeout: 30_000 });
  await expect(output(ravi)).toContainText("hi Ravi");
});

test("test cases are shared, and a test run shows its results for everyone", async ({ browser }) => {
  const teacher = await freshPage(browser);
  const link = await startSession(teacher, "Python");
  await setCode(teacher, 'name = input()\nprint("hi " + name)\n');
  const ravi = await freshPage(browser);
  await joinSession(ravi, link, "Ravi", "input(");

  await teacher.getByRole("button", { name: "Tests", exact: true }).click();
  const tPanel = teacher.getByRole("region", { name: "Tests" });
  await tPanel.getByRole("button", { name: /Add a test/ }).click();
  await tPanel.getByRole("textbox", { name: /^Input/ }).fill("Ada");
  await tPanel.getByRole("textbox", { name: /^Expected output/ }).fill("hi Ada");

  await ravi.getByRole("button", { name: "Tests", exact: true }).click();
  const rPanel = ravi.getByRole("region", { name: "Tests" });
  await expect(rPanel.getByRole("textbox", { name: /^Expected output/ })).toHaveValue("hi Ada");
  await rPanel.getByRole("button", { name: "Run all" }).click();
  await expect(rPanel.getByText("1 / 1 passed")).toBeVisible({ timeout: 90_000 });
  await expect(tPanel.getByText("1 / 1 passed")).toBeVisible({ timeout: 30_000 });
});

test("inviting by email checks the addresses; WhatsApp gets the link", async ({ browser }) => {
  const teacher = await freshPage(browser);
  const link = await startSession(teacher);
  await teacher.getByRole("button", { name: /Live session: 1 person/ }).click();
  const panel = teacher.getByRole("dialog", { name: "Live session" });
  await panel.getByRole("textbox", { name: "Invite by email" }).fill("friend@gmail.com, not-an-email");
  await panel.getByRole("button", { name: "Email" }).click();
  await expect(panel.getByText("Check this address: not-an-email")).toBeVisible();
  const whatsapp = await panel.getByRole("link", { name: "WhatsApp" }).getAttribute("href");
  expect(decodeURIComponent(whatsapp!.split("text=")[1]!)).toContain(link);
});
