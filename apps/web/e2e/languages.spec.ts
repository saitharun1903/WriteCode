import { expect, test, type Page } from "@playwright/test";

/**
 * The languages beyond the first six, through the real browser, API, queue and
 * sandboxes (Go, Rust, C#, PHP, Ruby, SQL, Bash), and web projects (HTML, CSS,
 * JavaScript), which run in a preview in the browser.
 * The sandboxed ones need the full stack: run with E2E_EXECUTION=1.
 */
test.setTimeout(240_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
// The output of a SQL run is a region with a tab per result; for the other languages it is the console.
const output = (page: Page) => page.locator('[aria-label="Program output"]').first();

async function freshProject(page: Page, language: string, starts: string) {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("code-workspace");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await page.getByRole("heading", { name: "New project" }).waitFor();
  const tile = page.getByRole("button", { name: `New ${language} project` });
  // The languages past the first eight are behind "More languages".
  if (!(await tile.isVisible())) await page.getByRole("button", { name: "More languages" }).click();
  await tile.click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(editor(page)).toContainText(starts);
}

async function setCode(page: Page, code: string) {
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

test("Kotlin, Go, Rust, C#, PHP, Ruby, SQL and Bash: the starter runs, input is read, and an error opens its line", async ({ page }) => {
  test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
  // [language, what the starter prints, a program that reads a number and doubles it, a program with a mistake on line `line`, has the debugger and visualizer]
  const programs: [string, string, string | null, string, number, boolean][] = [
    ["Kotlin", "Hello World", "fun main() {\n    val n = readln().toInt()\n    println(n * 2)\n}\n", 'fun main() {\n    val n: Int = "text"\n}\n', 2, true],
    ["Go", "Hello World", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar n int\n\tfmt.Scan(&n)\n\tfmt.Println(n * 2)\n}\n', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(missing)\n}\n', 6, false],
    ["Rust", "Hello World", 'use std::io;\n\nfn main() {\n    let mut line = String::new();\n    io::stdin().read_line(&mut line).unwrap();\n    let n: i32 = line.trim().parse().unwrap();\n    println!("{}", n * 2);\n}\n', 'fn main() {\n    let n: i32 = "text";\n    println!("{}", n);\n}\n', 2, false],
    ["C#", "Hello World", "using System;\n\nclass Program\n{\n    static void Main()\n    {\n        int n = int.Parse(Console.ReadLine());\n        Console.WriteLine(n * 2);\n    }\n}\n", 'class Program\n{\n    static void Main()\n    {\n        int n = "text";\n    }\n}\n', 5, false],
    ["PHP", "Hello World", '<?php\n$n = (int) trim(fgets(STDIN));\necho $n * 2, "\\n";\n', "<?php\necho 1\necho 2;\n", 3, false],
    ["Ruby", "Hello World", "n = gets.to_i\nputs n * 2\n", 'def f\n  raise "boom"\nend\nf\n', 2, false],
    ["SQL", "Hyderabad", null, "CREATE TABLE t (id INTEGER);\n\nSELECT * FROM missing;\n", 3, false],
    ["Bash", "Hello World", "read n\necho $(( n * 2 ))\n", "echo start\nnosuchcommand\n", 2, false],
  ];
  for (const [language, hello, doubles, broken, line, tools] of programs) {
    await freshProject(page, language, language === "SQL" ? "CREATE TABLE" : "Hello World");
    await expect(page.getByText("Runner online"), language).toBeVisible({ timeout: 30_000 });
    // The debugger and the visualizer are offered only where they work.
    await expect(page.getByRole("button", { name: "Debug program" }), language).toHaveCount(tools ? 1 : 0);
    await expect(page.getByRole("button", { name: "Visualize execution" }), language).toHaveCount(tools ? 1 : 0);
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(output(page), language).toContainText(hello, { timeout: 120_000 });
    await expect(page.getByText("Success", { exact: true }), language).toBeVisible();

    if (doubles) {
      await setCode(page, doubles);
      await page.getByRole("button", { name: "Run program" }).click();
      const input = page.getByRole("textbox", { name: "Program input" });
      await expect(input, language).toBeVisible({ timeout: 120_000 });
      await input.fill("21");
      await page.keyboard.press("Enter");
      await expect(output(page), language).toContainText("42", { timeout: 60_000 });
    }

    await setCode(page, broken);
    await page.getByRole("button", { name: "Run program" }).click();
    // The error names its line, and the line is a link into the code.
    const link = output(page).getByRole("button", { name: new RegExp(`:${line}\\b|line ${line}\\b|\\(${line},`) }).first();
    await expect(link, language).toBeVisible({ timeout: 120_000 });
    await link.click();
    await expect(page.getByRole("button", { name: "Go to line" }), language).toHaveText(new RegExp(`^${line}:`));
  }
});

const database = (page: Page) => page.getByRole("region", { name: "Database" });

async function newFile(page: Page, name: string, code: string) {
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name })).toBeVisible();
  await setCode(page, code);
}

test("SQL: a tab of rows for every query, a list of what each statement did, and SQL written for MySQL", async ({ page }) => {
  test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
  await freshProject(page, "SQL", "CREATE TABLE");
  await page.getByRole("button", { name: "Run program" }).click();
  // The starter has two queries on one table: a tab for each, named after the table, and the last one is shown.
  const tabs = output(page).getByRole("tablist", { name: "Results" });
  await expect(tabs.getByRole("tab")).toHaveText([/^students 1\s*4$/, /^students 2\s*3$/, /^Output\s*5$/], { timeout: 120_000 });
  const second = output(page).getByRole("table", { name: "Result 2" });
  await expect(second.getByRole("columnheader")).toHaveText(["city", "students", "average"]);
  await tabs.getByRole("tab", { name: /students 1/ }).click();
  const first = output(page).getByRole("table", { name: "Result 1" });
  await expect(first.getByRole("columnheader")).toHaveText(["name", "city", "marks"]);
  await expect(first.getByRole("row")).toHaveCount(5);
  // Each row has its number, then its cells; numbers are set to the right, as in a spreadsheet.
  await expect(first.getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "Asha", "Hyderabad", "91"]);
  await expect(first.getByRole("row").nth(1).getByRole("cell").nth(3)).toHaveCSS("text-align", "right");
  await expect(output(page)).toContainText("4 rows");
  // Output: every statement with its line, what it did and how long it took.
  await tabs.getByRole("tab", { name: /Output/ }).click();
  const statements = output(page).getByRole("table", { name: "Statements" });
  await expect(statements.getByRole("row")).toHaveCount(6);
  await expect(statements).toContainText("Table students created");
  await expect(statements).toContainText("4 rows inserted into students");
  await expect(statements).toContainText("3 rows returned");
  await statements.getByRole("button", { name: "12", exact: true }).click();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(/^12:/);

  await setCode(
    page,
    "CREATE DATABASE shop;\nUSE shop;\nCREATE TABLE items (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(40) NOT NULL,\n  price DECIMAL(8,2),\n  note TEXT\n) ENGINE=InnoDB;\nINSERT INTO items (name, price) VALUES ('Pen', 10), ('Book | A5', 55.5);\nSHOW DATABASES;\nSHOW TABLES;\nDESCRIBE items;\nSELECT id, name, price, note, CONCAT(name, ': ', price) AS label FROM items;\nUPDATE items SET price = price + 1 WHERE price > 20;\nSELECT * FROM missing_table;\n",
  );
  await page.getByRole("button", { name: "Run program" }).click();
  // The run stops at the first error: Output is shown, with the error and the line of its statement.
  await expect(output(page)).toContainText("no such table: missing_table", { timeout: 120_000 });
  await expect(output(page)).toContainText("The tables in the database: items, students.");
  await expect(output(page).getByRole("table", { name: "Statements" })).toContainText("1 row updated in items");
  await output(page).getByRole("button", { name: /main\.sql:15/ }).click();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(/^15:/);
  // What ran before the error is there: the database's name, its tables, the structure of one, and its rows.
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await tabs.getByRole("tab").nth(0).click();
  await expect(output(page).getByRole("table", { name: "Result 1" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "shop"]);
  await tabs.getByRole("tab", { name: /items · structure/ }).click();
  await expect(output(page).getByRole("table", { name: "Result 3" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "id", "INTEGER", "NO", "PRI", "NULL"]);
  await tabs.getByRole("tab").nth(3).click();
  const rows = output(page).getByRole("table", { name: "Result 4" });
  // The ids were counted up; a bar inside a value stays inside its cell; NULL is NULL.
  await expect(rows.getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "1", "Pen", "10", "NULL", "Pen: 10"]);
  await expect(rows.getByRole("row").nth(2).getByRole("cell")).toHaveText(["2", "2", "Book | A5", "55.5", "NULL", "Book | A5: 55.5"]);
});

test("SQL: the project has a database, as in a database tool: it keeps its tables between runs and files, and shows what is in it", async ({ page }) => {
  test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
  await freshProject(page, "SQL", "CREATE TABLE");
  const db = database(page);
  await expect(db).toContainText("No tables yet");
  await page.getByRole("button", { name: "Run program" }).click();
  // The table the run made is in the database panel, with its row count and, opened, its columns.
  const students = db.getByRole("button", { name: "students", exact: true });
  await expect(students).toBeVisible({ timeout: 120_000 });
  await expect(db.getByRole("region", { name: "Tables" })).toContainText("4");
  await students.click();
  await expect(db.getByRole("list", { name: "Columns of students" }).getByRole("listitem")).toHaveText([/^id\s*integer$/i, /^name\s*text$/i, /^city\s*text$/i, /^marks\s*integer$/i]);

  // Another file of the project queries the table the first one made.
  await newFile(page, "queries.sql", "SELECT MAX(marks) AS top FROM students;\nINSERT INTO students (name, city, marks) VALUES ('Zoya', 'Pune', 99);\nSELECT COUNT(*) AS n FROM students;\n");
  await page.getByRole("button", { name: "Run program" }).click();
  const tabs = output(page).getByRole("tablist", { name: "Results" });
  await expect(tabs.getByRole("tab")).toHaveCount(3, { timeout: 120_000 });
  await expect(output(page).getByRole("table", { name: "Result 2" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "5"]);
  await tabs.getByRole("tab").first().click();
  await expect(output(page).getByRole("table", { name: "Result 1" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "91"]);

  // Only the selected statement runs, and an error in it still names its own line.
  await setCode(page, "SELECT COUNT(*) AS n FROM students;\nSELECT absent FROM students;\nSELECT 'whole file';\n");
  await page.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { setSelection(r: object): void }[] } } }).monaco;
    m.editor.getEditors()[0]!.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 40 });
  });
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByRole("region", { name: "Run" }).getByText("queries.sql · line 1")).toBeVisible({ timeout: 120_000 });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await expect(output(page).getByRole("table", { name: "Result 1" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "5"]);
  await page.evaluate(() => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { setSelection(r: object): void }[] } } }).monaco;
    m.editor.getEditors()[0]!.setSelection({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 40 });
  });
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("queries.sql:2: error: no such column: absent", { timeout: 120_000 });

  // The database is the project's: it is there after the page is loaded again.
  await page.reload();
  await expect(database(page).getByRole("button", { name: "students", exact: true })).toBeVisible();
  await expect(database(page).getByRole("region", { name: "Tables" })).toContainText("5");

  // A table opens from the panel without writing a query.
  await database(page).getByRole("button", { name: "Show the rows of students" }).click();
  const shown = output(page).getByRole("table", { name: "Result 1" });
  await expect(shown.getByRole("row")).toHaveCount(6, { timeout: 120_000 });
  await expect(shown.getByRole("row").nth(5).getByRole("cell")).toHaveText(["5", "5", "Zoya", "Pune", "99"]);
  await expect(page.getByRole("region", { name: "Run" }).getByText("students", { exact: true }).first()).toBeVisible();

  // Making a table that is already there says why, and offers the way out.
  await setCode(page, "CREATE TABLE students (id INTEGER);\nSELECT COUNT(*) AS n FROM students;\n");
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(output(page)).toContainText("table students already exists", { timeout: 120_000 });
  await expect(output(page)).toContainText("Write DROP TABLE IF EXISTS students; above this statement, or reset the database.");
  await output(page).getByRole("button", { name: "Empty the database and run again" }).click();
  await expect(output(page).getByRole("table", { name: "Result 1" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "0"], { timeout: 120_000 });
  await expect(database(page).getByRole("list", { name: "Columns of students" })).toHaveCount(0);

  // Emptying the database from the panel leaves the files alone.
  await database(page).getByRole("button", { name: "Empty the database" }).click();
  await page.getByRole("dialog", { name: "Empty the database?" }).getByRole("button", { name: "Empty the database" }).click();
  await expect(database(page)).toContainText("No tables yet");
  await expect(page.getByRole("treeitem", { name: /queries\.sql/ })).toBeVisible();
});

test("SQL: what the assistant writes goes into the file that is open, not into another one", async ({ page }) => {
  await freshProject(page, "SQL", "CREATE TABLE");
  const main = await page.evaluate(() => (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { getValue(): string } }[] } } }).monaco.editor.getEditors()[0]!.getModel().getValue());
  await newFile(page, "sai.sql", "");
  // The model's answer is given here, so the test is about what the IDE sends and does with it.
  let sent: { context: { activeFile?: string; files: { path: string; content: string }[] } } | null = null;
  await page.route("**/api/v1/assistant/status", (route) => route.fulfill({ json: { available: true } }));
  await page.route("**/api/v1/assistant/chat", async (route) => {
    sent = route.request().postDataJSON();
    const answer = "Here is the query:\n\n```edit\nFILE: sai.sql\n<<<<<<< ORIGINAL\n=======\nSELECT MAX(marks) AS top FROM students;\n>>>>>>> UPDATED\n```\n";
    await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "text", text: answer })}\n\ndata: ${JSON.stringify({ type: "done" })}\n\n` });
  });
  await page.getByRole("button", { name: "AI Assistant" }).click();
  const panel = page.getByRole("region", { name: "AI Assistant" });
  await panel.getByLabel("Ask the assistant").fill("give code for max marks");
  await page.keyboard.press("Enter");
  const card = panel.getByRole("group", { name: "Suggested change to sai.sql" });
  await card.getByRole("button", { name: "Apply fix" }).click();
  await expect(panel.getByText("Applied")).toBeVisible();
  // The assistant was told which file is open (and that it is empty)...
  expect(sent!.context.activeFile).toBe("sai.sql");
  expect(sent!.context.files[0]).toEqual({ path: "sai.sql", content: "" });
  // ...and its code is in that file; the other file is as it was.
  await expect(editor(page)).toContainText("SELECT MAX(marks) AS top FROM students;");
  await page.getByRole("treeitem", { name: /main\.sql/ }).click();
  await expect(editor(page)).toContainText("DROP TABLE IF EXISTS students;");
  const after = await page.evaluate(() => (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { getValue(): string } }[] } } }).monaco.editor.getEditors()[0]!.getModel().getValue());
  expect(after).toBe(main);
});

test("a web project runs in a browser of its own beside the code: the page, its styles, its script, its console, as it is typed", async ({ page }) => {
  await freshProject(page, "HTML, CSS, JS", "Hello World");
  // The preview is there as soon as the project opens: its bar shows the page's title and file, like a browser inside an app.
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview).toBeVisible();
  const shown = preview.frameLocator('iframe[title="Page preview"]');
  await expect(shown.getByRole("heading", { name: "Hello World" })).toBeVisible();
  await expect(preview.getByText("My page", { exact: true })).toBeVisible();
  await expect(preview.getByText("index.html", { exact: true })).toBeVisible();
  // It stands beside the code, not under it.
  const [code, frame] = [(await page.locator(".monaco-editor").first().boundingBox())!, (await preview.boundingBox())!];
  expect(frame.x).toBeGreaterThan(code.x + 200);
  // The code keeps most of the room, so its lines are read in full; the page can be dragged wider.
  expect(code.width).toBeGreaterThan(frame.width * 1.3);
  expect(frame.height).toBeGreaterThan(500);
  // style.css is applied, and script.js runs.
  await expect(shown.getByRole("button", { name: "Click me" })).toHaveCSS("background-color", "rgb(53, 116, 240)");
  await shown.getByRole("button", { name: "Click me" }).click();
  await shown.getByRole("button", { name: "Click me" }).click();
  await expect(shown.locator("#count")).toHaveText("2");
  // What the page logs is one press away.
  await preview.getByRole("button", { name: "Console" }).click();
  const log = preview.getByRole("log", { name: "Page console" });
  await expect(log).toContainText("Clicked 1");
  await expect(log).toContainText("Clicked 2");

  // The page follows the code as it is typed, without pressing Run.
  await setCode(page, '<!DOCTYPE html>\n<html>\n  <head>\n    <title>Second</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Changed</h1>\n    <a href="about.html">About</a>\n    <script>\n      localStorage.setItem("k", "kept");\n      console.warn(localStorage.getItem("k"));\n      nothingHere();\n    </script>\n  </body>\n</html>\n');
  await expect(shown.getByRole("heading", { name: "Changed" })).toBeVisible();
  await expect(preview.getByText("Second", { exact: true })).toBeVisible();
  // A page that uses localStorage works; an error in its script is shown, in red, and counted on the console's button.
  await expect(log).toContainText("kept");
  await expect(log.locator("li.text-danger")).toContainText("nothingHere is not defined");
  await expect(preview.getByRole("button", { name: "Console: 1 error" })).toBeVisible();

  // The page cannot reach this site: it has an origin of its own.
  const origin = await shown.locator("html").evaluate(() => window.origin);
  expect(origin).toBe("null");

  // A link to another page of the project shows that page; Back returns.
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("about.html");
  await page.keyboard.press("Enter");
  await setCode(page, "<title>About</title>\n<h1>About us</h1>\n");
  await expect(shown.getByRole("heading", { name: "About us" })).toBeVisible();
  await page.getByRole("treeitem", { name: /index\.html/ }).click();
  await expect(shown.getByRole("heading", { name: "Changed" })).toBeVisible();
  await shown.getByRole("link", { name: "About" }).click();
  await expect(shown.getByRole("heading", { name: "About us" })).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Page" })).toHaveValue("about.html");
  await preview.getByRole("button", { name: "Back" }).click();
  await expect(shown.getByRole("heading", { name: "Changed" })).toBeVisible();

  // Filling the window, and leaving it; closing it, and Run bringing it back.
  await preview.getByRole("button", { name: "Fill the window" }).click();
  await expect.poll(async () => (await preview.boundingBox())!.x).toBe(0);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await preview.boundingBox())!.x).toBeGreaterThan(200);
  await preview.getByRole("button", { name: "Close the preview" }).click();
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(shown.getByRole("heading", { name: "Changed" })).toBeVisible();

  // A web project has nothing to debug or visualize on the server.
  await expect(page.getByRole("button", { name: "Debug program" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Visualize execution" })).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a web project's page opens over the code like a link inside an app, and closes back to the code", async ({ page }) => {
    await freshProject(page, "HTML, CSS, JS", "Hello World");
    const preview = page.getByRole("region", { name: "Preview" });
    await expect(preview).toBeVisible();
    const box = (await preview.boundingBox())!;
    expect([box.x, box.y, box.width]).toEqual([0, 0, 390]);
    expect(box.height).toBeGreaterThan(800);
    await expect(preview.frameLocator('iframe[title="Page preview"]').getByRole("button", { name: "Click me" })).toBeVisible();
    await preview.getByRole("button", { name: "Close the preview" }).click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".monaco-editor").first()).toBeVisible();
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(preview).toBeVisible();
  });
});

test("the start screen shows the languages most people use; the rest are one press away, and its parts are one press away too", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("heading", { name: "New project" }).waitFor();
  const tiles = page.getByRole("button", { name: /^New .+ project$/ });
  const names = () => tiles.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")!.slice(4, -8)));
  expect(await names()).toEqual(["Python", "Java", "C++", "C", "JavaScript", "HTML, CSS, JS", "SQL", "TypeScript"]);
  const more = page.getByRole("button", { name: "More languages" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(tiles).toHaveCount(15);
  expect((await names()).slice(8)).toEqual(["Kotlin", "Go", "Rust", "C#", "PHP", "Ruby", "Bash"]);
  await page.getByRole("button", { name: "Fewer languages" }).click();
  await expect(tiles).toHaveCount(8);

  // The links at the top stay in view and say which part of the page is on screen.
  const nav = page.getByRole("navigation", { name: "On this page" });
  await expect(nav.getByRole("button", { name: "New project" })).toHaveAttribute("aria-current", "true");
  await nav.getByRole("button", { name: "Questions" }).click();
  await expect(page.getByRole("heading", { name: "Questions and answers" })).toBeInViewport();
  await expect(nav.getByRole("button", { name: "Questions" })).toHaveAttribute("aria-current", "true");
  await expect(nav).toBeInViewport();
  // Recent projects and interviews are always there, even with nothing in them yet.
  await nav.getByRole("button", { name: "Recent" }).click();
  await expect(page.getByRole("heading", { name: "Recent projects" })).toBeInViewport();
  await expect(page.getByRole("heading", { name: "Interviews" })).toBeInViewport();
});
