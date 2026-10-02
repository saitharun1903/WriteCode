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

test("Go, Rust, C#, PHP, Ruby, SQL and Bash: the starter runs, input is read, and an error opens its line", async ({ page }) => {
  test.skip(!process.env.E2E_EXECUTION, "needs the API, worker and Docker");
  // [language, what the starter prints, a program that reads a number and doubles it, a program with a mistake on line `line`]
  const programs: [string, string, string | null, string, number][] = [
    ["Go", "Hello World", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvar n int\n\tfmt.Scan(&n)\n\tfmt.Println(n * 2)\n}\n', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(missing)\n}\n', 6],
    ["Rust", "Hello World", 'use std::io;\n\nfn main() {\n    let mut line = String::new();\n    io::stdin().read_line(&mut line).unwrap();\n    let n: i32 = line.trim().parse().unwrap();\n    println!("{}", n * 2);\n}\n', 'fn main() {\n    let n: i32 = "text";\n    println!("{}", n);\n}\n', 2],
    ["C#", "Hello World", "using System;\n\nclass Program\n{\n    static void Main()\n    {\n        int n = int.Parse(Console.ReadLine());\n        Console.WriteLine(n * 2);\n    }\n}\n", 'class Program\n{\n    static void Main()\n    {\n        int n = "text";\n    }\n}\n', 5],
    ["PHP", "Hello World", '<?php\n$n = (int) trim(fgets(STDIN));\necho $n * 2, "\\n";\n', "<?php\necho 1\necho 2;\n", 3],
    ["Ruby", "Hello World", "n = gets.to_i\nputs n * 2\n", 'def f\n  raise "boom"\nend\nf\n', 2],
    ["SQL", "Asha", null, "CREATE TABLE t (id INTEGER);\n\nSELECT * FROM missing;\n", 3],
    ["Bash", "Hello World", "read n\necho $(( n * 2 ))\n", "echo start\nnosuchcommand\n", 2],
  ];
  for (const [language, hello, doubles, broken, line] of programs) {
    await freshProject(page, language, language === "SQL" ? "CREATE TABLE" : "Hello World");
    await expect(page.getByText("Runner online"), language).toBeVisible({ timeout: 30_000 });
    // These languages run and are tested; the debugger and the visualizer are not offered for them.
    await expect(page.getByRole("button", { name: "Debug program" }), language).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Visualize execution" }), language).toHaveCount(0);
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

test("a web project runs in the preview: the page, its styles, its script, its console, as it is typed", async ({ page }) => {
  await freshProject(page, "HTML, CSS, JS", "Hello World");
  await page.getByRole("button", { name: "Run program" }).click();
  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview).toBeVisible();
  const shown = preview.frameLocator('iframe[title="Page preview"]');
  await expect(shown.getByRole("heading", { name: "Hello World" })).toBeVisible();
  // style.css is applied, and script.js runs.
  await expect(shown.getByRole("button", { name: "Click me" })).toHaveCSS("background-color", "rgb(53, 116, 240)");
  await shown.getByRole("button", { name: "Click me" }).click();
  await shown.getByRole("button", { name: "Click me" }).click();
  await expect(shown.locator("#count")).toHaveText("2");
  // What the page logs is under it.
  const log = preview.getByRole("log", { name: "Page console" });
  await expect(log).toContainText("Clicked 1");
  await expect(log).toContainText("Clicked 2");

  // The page follows the code as it is typed, without pressing Run.
  await setCode(page, '<!DOCTYPE html>\n<html>\n  <head>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Changed</h1>\n    <a href="about.html">About</a>\n    <script>\n      localStorage.setItem("k", "kept");\n      console.warn(localStorage.getItem("k"));\n      nothingHere();\n    </script>\n  </body>\n</html>\n');
  await expect(shown.getByRole("heading", { name: "Changed" })).toBeVisible();
  // A page that uses localStorage works; an error in its script is shown, in red.
  await expect(log).toContainText("kept");
  await expect(log.locator("li.text-danger")).toContainText("nothingHere is not defined");
  await expect(preview.getByText("1 error")).toBeVisible();

  // The page cannot reach this site: it has an origin of its own.
  const origin = await shown.locator("html").evaluate(() => window.origin);
  expect(origin).toBe("null");

  // A link to another page of the project shows that page.
  await page.getByRole("button", { name: "New File" }).first().click();
  await page.getByRole("textbox", { name: "Name" }).fill("about.html");
  await page.keyboard.press("Enter");
  await setCode(page, "<h1>About us</h1>\n");
  await expect(shown.getByRole("heading", { name: "About us" })).toBeVisible();
  await page.getByRole("treeitem", { name: /index\.html/ }).click();
  await expect(shown.getByRole("heading", { name: "Changed" })).toBeVisible();
  await shown.getByRole("link", { name: "About" }).click();
  await expect(shown.getByRole("heading", { name: "About us" })).toBeVisible();
  await expect(preview.getByRole("combobox", { name: "Page" })).toHaveValue("about.html");

  // A web project has nothing to debug or visualize on the server.
  await expect(page.getByRole("button", { name: "Debug program" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Visualize execution" })).toHaveCount(0);
});
