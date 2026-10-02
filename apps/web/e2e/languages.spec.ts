import { expect, test, type Page } from "@playwright/test";

/**
 * The languages beyond the first six, through the real browser, API, queue and
 * sandboxes (Go, Rust, C#, PHP, Ruby, SQL, Bash), and web projects (HTML, CSS,
 * JavaScript), which run in a preview in the browser.
 * The sandboxed ones need the full stack: run with E2E_EXECUTION=1.
 */
test.setTimeout(240_000);

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const output = (page: Page) => page.getByRole("log", { name: "Program output" });

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
  await page.getByRole("button", { name: `New ${language} project` }).click();
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
    ["SQL", "Asha", null, "CREATE TABLE t (id INTEGER);\n\nSELECT * FROM missing;\n", 3, false],
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

test("SQL: every query's rows are a table; other statements say what they did; SQL written for MySQL runs", async ({ page }) => {
  test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
  await freshProject(page, "SQL", "CREATE TABLE");
  await page.getByRole("button", { name: "Run program" }).click();
  // The starter has two queries: two tables, with their column names and rows.
  const first = output(page).getByRole("table", { name: "Result 1" });
  await expect(first).toBeVisible({ timeout: 120_000 });
  await expect(first.getByRole("columnheader")).toHaveText(["name", "city", "marks"]);
  await expect(first.getByRole("row")).toHaveCount(5);
  await expect(first.getByRole("row").nth(1).getByRole("cell")).toHaveText(["Asha", "Hyderabad", "91"]);
  await expect(output(page).getByRole("table", { name: "Result 2" }).getByRole("columnheader")).toHaveText(["city", "students", "average"]);
  await expect(output(page)).toContainText("Table students created");
  await expect(output(page)).toContainText("4 rows inserted into students");
  // Numbers are set to the right, as in a spreadsheet.
  await expect(first.getByRole("row").nth(1).getByRole("cell").nth(2)).toHaveCSS("text-align", "right");

  await setCode(
    page,
    "CREATE DATABASE shop;\nUSE shop;\nCREATE TABLE items (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(40) NOT NULL,\n  price DECIMAL(8,2),\n  note TEXT\n) ENGINE=InnoDB;\nINSERT INTO items (name, price) VALUES ('Pen', 10), ('Book | A5', 55.5);\nSHOW TABLES;\nDESCRIBE items;\nSELECT id, name, price, note, CONCAT(name, ': ', price) AS label FROM items;\nUPDATE items SET price = price + 1 WHERE price > 20;\nSELECT * FROM missing_table;\n",
  );
  await page.getByRole("button", { name: "Run program" }).click();
  const rows = output(page).getByRole("table", { name: "Result 3" });
  await expect(rows).toBeVisible({ timeout: 120_000 });
  await expect(output(page).getByRole("table", { name: "Result 1" }).getByRole("columnheader")).toHaveText(["Tables"]);
  await expect(output(page).getByRole("table", { name: "Result 2" }).getByRole("row").nth(1).getByRole("cell")).toHaveText(["id", "INTEGER", "NO", "PRI", "NULL"]);
  // The ids were counted up; a bar inside a value stays inside its cell; NULL is NULL.
  await expect(rows.getByRole("row").nth(1).getByRole("cell")).toHaveText(["1", "Pen", "10", "NULL", "Pen: 10"]);
  await expect(rows.getByRole("row").nth(2).getByRole("cell")).toHaveText(["2", "Book | A5", "55.5", "NULL", "Book | A5: 55.5"]);
  await expect(output(page)).toContainText("1 row updated in items");
  // The run stops at the first error, which names the line of its statement.
  await expect(output(page)).toContainText("no such table: missing_table");
  const link = output(page).getByRole("button", { name: /main\.sql:14/ });
  await link.click();
  await expect(page.getByRole("button", { name: "Go to line" })).toHaveText(/^14:/);
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
