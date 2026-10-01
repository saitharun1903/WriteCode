import { expect, test, type Page } from "@playwright/test";

/**
 * The Tests tool window against the real stack: tests are saved with the
 * project, run together in one sandbox, and judged line by line.
 * Run with E2E_EXECUTION=1 (API, worker and Docker running).
 */
test.skip(!process.env.E2E_EXECUTION, "set E2E_EXECUTION=1 with the API, worker and Docker running");
test.setTimeout(180_000);

const shots = process.env.E2E_SHOTS;

async function waitSaved(page: Page) {
  await page.locator('footer[data-save-state="saved"]').waitFor({ state: "attached" });
}

async function freshJava(page: Page, language = "Java") {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("code-workspace");
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByText("Runner online")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: `New ${language} project` }).click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("Hello World");
}

async function setCode(page: Page, code: string) {
  await page.evaluate((text) => {
    const m = (window as unknown as { monaco: { editor: { getEditors(): { getModel(): { setValue(v: string): void } }[] } } }).monaco;
    m.editor.getEditors()[0]!.getModel().setValue(text);
  }, code);
  await waitSaved(page);
}

// Largest of n numbers, with a classic bug: starting from 0 breaks all-negative input.
const MAX = `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        int max = 0;
        for (int i = 0; i < n; i++) {
            max = Math.max(max, in.nextInt());
        }
        System.out.println(max);
    }
}
`;

const panel = (page: Page) => page.getByRole("region", { name: "Tests" });
const list = (page: Page) => panel(page).getByRole("listbox", { name: "Tests" });

async function fillTest(page: Page, input: string, expected: string) {
  await panel(page).getByRole("textbox", { name: /^Input/ }).fill(input);
  await panel(page).getByRole("textbox", { name: /^Expected output/ }).fill(expected);
}

test("tests: add, run all, see the wrong line, fix the code, all pass, saved with the project", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshJava(page);
  await setCode(page, MAX);

  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(panel(page).getByText("Check your program against test cases")).toBeVisible();
  await panel(page).getByRole("button", { name: /Add a test/ }).click();
  await fillTest(page, "3\n1 5 2", "5");
  await panel(page).getByRole("button", { name: "Add test" }).click();
  await fillTest(page, "2\n-4 -7", "-4");
  await panel(page).getByRole("button", { name: "Add test" }).click();
  // Trailing spaces and blank lines in the expected output do not matter.
  await fillTest(page, "1\n9", "9  \n\n");
  await waitSaved(page);

  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(panel(page).getByText("2 / 3 passed")).toBeVisible({ timeout: 60_000 });
  await expect(list(page).getByRole("option", { name: /Test 1.*Passed/ })).toBeVisible();
  await expect(list(page).getByRole("option", { name: /Test 2.*Wrong answer/ })).toBeVisible();
  await expect(list(page).getByRole("option", { name: /Test 3.*Passed/ })).toBeVisible();

  await list(page).getByRole("option", { name: /Test 2/ }).click();
  await expect(panel(page).getByText("First difference on line 1")).toBeVisible();
  const row = panel(page).getByRole("row").nth(1);
  await expect(row).toContainText("-4");
  await expect(row).toContainText("0");
  if (shots) await page.screenshot({ path: `${shots}/tests-wrong-answer.png` });

  // Fix the bug; the tests re-run and all pass.
  await page.getByRole("tab", { name: /Main\.java/ }).click();
  await setCode(page, MAX.replace("int max = 0;", "int max = Integer.MIN_VALUE;"));
  await page.keyboard.press("Control+Shift+Enter");
  await expect(panel(page).getByText("3 / 3 passed")).toBeVisible({ timeout: 60_000 });
  if (shots) await page.screenshot({ path: `${shots}/tests-all-passed.png` });

  // Tests are part of the project.
  await page.reload();
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(list(page).getByRole("option")).toHaveCount(3);
});

test("tests: an endless loop or a crash only fails its own test; compile errors are shown once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshJava(page);
  await setCode(
    page,
    `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        int n = new Scanner(System.in).nextInt();
        while (n < 0) { }
        System.out.println(100 / n);
    }
}
`,
  );
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await panel(page).getByRole("button", { name: /Add a test/ }).click();
  await fillTest(page, "-1", "");
  await panel(page).getByRole("button", { name: "Add test" }).click();
  await fillTest(page, "0", "");
  await panel(page).getByRole("button", { name: "Add test" }).click();
  await fillTest(page, "4", "25");
  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(panel(page).getByText("1 / 3 passed")).toBeVisible({ timeout: 90_000 });
  await expect(list(page).getByRole("option", { name: /Test 1.*Time limit/ })).toBeVisible();
  await expect(list(page).getByRole("option", { name: /Test 2.*Runtime error/ })).toBeVisible();
  await list(page).getByRole("option", { name: /Test 2/ }).click();
  await expect(panel(page).getByText("ArithmeticException")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/tests-runtime-error.png` });

  await page.getByRole("tab", { name: /Main\.java/ }).click();
  await setCode(page, "public class Main {\n    public static void main(String[] args) {\n        int x = ;\n    }\n}\n");
  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(panel(page).getByText("Didn’t compile")).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).getByText("Compiler output")).toBeVisible();
});

for (const [language, file, reads] of [
  ["Java", "Main.java", "int n = in.nextInt();"],
  ["Python", "main.py", "n = int(input())"],
  ["C++", "main.cpp", "std::cin >> n;"],
  ["C", "main.c", 'scanf("%d", &n);'],
  ["JavaScript", "main.js", "const n = data[0];"],
  ["TypeScript", "main.ts", "const n = data[0];"],
] as const) {
  test(`${language}: "Add to code" puts the lines that read input into the program, and it still runs`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await freshJava(page, language);
    await page.getByRole("button", { name: "Tests", exact: true }).click();
    await panel(page).getByRole("button", { name: /Add a test/ }).click();
    await fillTest(page, "", "Hello World");
    const note = panel(page).getByRole("note", { name: "Program ignores input" });
    await expect(note).toContainText(`${file} never reads its input`);

    // One click: the lines are in the editor where the program starts, and the test has something to read.
    await note.getByRole("button", { name: "Add to code" }).click();
    const code = () => page.evaluate(() => (window as unknown as { monaco: { editor: { getModels(): { getValue(): string }[] } } }).monaco.editor.getModels()[0]!.getValue());
    await expect.poll(code).toContain(reads);
    expect(await code()).toContain("Hello World");
    await expect(note).toHaveCount(0);
    await expect(panel(page).getByRole("textbox", { name: /^Input/ })).toHaveValue("3\n1 2 3\n");
    await waitSaved(page);

    // The program compiles and prints what it printed before.
    await panel(page).getByRole("button", { name: "Run all" }).click();
    await expect(panel(page).getByText("1 / 1 passed")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Run program" }).click();
    await expect(page.getByRole("log", { name: "Program output" })).toContainText("Process finished with exit code 0", { timeout: 60_000 });
    await expect(page.getByRole("log", { name: "Program output" })).toContainText("Hello World");
    // The console is only the program's output: nothing to save from it.
    await expect(page.getByRole("button", { name: "Save as test" })).toHaveCount(0);
  });
}

// The user's binary search: the value to find is fixed in the code, so every test prints -1.
const SEARCH = (body: string, imports = "") => `${imports}public class Main {
    public static int search(int[] arr, int s) {
        int low = 0, high = arr.length - 1;
        while (low <= high) {
            int mid = low + (high - low) / 2;
            if (s == arr[mid]) return mid;
            else if (s < arr[mid]) high = mid - 1;
            else low = mid + 1;
        }
        return -1;
    }
    public static void main(String[] args) {
${body}
    }
}
`;

test("a program that ignores its input is called out; once it reads input, each test gets its own answer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshJava(page);
  await setCode(page, SEARCH("        int arr[] = {3,4,6,7,9,12,16,17};\n        int n = 5;\n        System.out.println(search(arr, n));"));
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await panel(page).getByRole("button", { name: /Add a test/ }).click();
  await fillTest(page, "8\n3 4 6 7 9 12 16 17\n9", "4");
  await panel(page).getByRole("button", { name: "Add test" }).click();
  await fillTest(page, "8\n3 4 6 7 9 12 16 17\n5", "-1");
  const note = panel(page).getByRole("note", { name: "Program ignores input" });
  await expect(note).toContainText("Main.java never reads its input");
  if (shots) await page.screenshot({ path: `${shots}/tests-ignores-input.png` });

  // One click rewrites the fixed values to read from input, adds the Scanner and its import,
  // and puts the old values in Program Input so a plain Run prints what it did before.
  await note.getByRole("button", { name: "Read from input" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { monaco: { editor: { getModels(): { getValue(): string }[] } } }).monaco.editor.getModels()[0]!.getValue())).toContain(
    "int[] arr = new int[in.nextInt()];",
  );
  const code = await page.evaluate(() => (window as unknown as { monaco: { editor: { getModels(): { getValue(): string }[] } } }).monaco.editor.getModels()[0]!.getValue());
  expect(code).toMatch(/^import java\.util\.Scanner;\n/);
  expect(code).toContain("Scanner in = new Scanner(System.in);");
  expect(code).toContain("int n = in.nextInt();");
  await waitSaved(page);
  await page.getByRole("button", { name: "Run program" }).click();
  await expect(page.getByRole("log", { name: "Program output" })).toContainText("-1", { timeout: 60_000 });
  await expect(page.getByRole("log", { name: "Program output" })).toContainText("Process finished with exit code 0");
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await expect(note).toHaveCount(0);
  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(panel(page).getByText("2 / 2 passed")).toBeVisible({ timeout: 60_000 });
  await list(page).getByRole("option", { name: /Test 1/ }).click();
  await expect(panel(page).getByText("Output matches")).toBeVisible();
  await expect(panel(page).locator("pre").last()).toHaveText("4");
});

test("stopping right after Run all stops the run, even before the server has accepted it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshJava(page);
  await setCode(page, MAX.replace("int max = 0;", "int max = Integer.MIN_VALUE;"));
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await panel(page).getByRole("button", { name: /Add a test/ }).click();
  await fillTest(page, "2\n1 2", "2");
  await waitSaved(page);
  await panel(page).getByRole("button", { name: "Run all" }).click();
  await panel(page).getByRole("button", { name: "Stop" }).click();
  await expect(panel(page).getByRole("button", { name: "Run all" })).toBeVisible();
  // Nothing from the abandoned run shows up later.
  await page.waitForTimeout(6000);
  await expect(list(page).getByRole("option", { name: /Test 1/ })).not.toContainText("Passed");

  // The next run works normally.
  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(panel(page).getByText("1 / 1 passed")).toBeVisible({ timeout: 60_000 });
});

test("a test whose input is missing a value: the failing line is named, the input format is shown, and it passes once fixed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await freshJava(page);
  await setCode(page, SEARCH("        int arr[] = {3,4,6,7,9,12,16,17};\n        int n = 5;\n\n        System.out.println(search(arr,n));"));
  await page.getByRole("button", { name: "Tests", exact: true }).click();
  await panel(page).getByRole("button", { name: /Add a test/ }).click();
  // Written for the old program: the array, but no value to search for.
  await fillTest(page, "5\n1 2 3 4 5", "3");
  await panel(page).getByRole("note", { name: "Program ignores input" }).getByRole("button", { name: "Read from input" }).click();
  await expect(panel(page).getByRole("note", { name: "Program ignores input" })).toHaveCount(0);
  await waitSaved(page);

  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(list(page).getByRole("option", { name: /Test 1.*Runtime error/ })).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).getByText(/^Line \d+ \(int n = in\.nextInt\(\);\) needed another value, but the input had no more\./)).toBeVisible();
  await expect(panel(page).getByText("arr: how many, then the values, then n")).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Ask AI why this test fails" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/tests-missing-input.png` });

  if (process.env.E2E_ASSISTANT) {
    // The assistant gets the test's input, outputs and error, and answers about the input.
    await panel(page).getByRole("button", { name: "Ask AI why this test fails" }).click();
    const ai = page.getByRole("region", { name: "AI Assistant" });
    await expect(ai.getByRole("log", { name: "Conversation" })).toContainText("Why does Test 1 fail?");
    await expect(ai.getByRole("button", { name: "Regenerate" })).toBeVisible({ timeout: 90_000 });
    if (shots) await page.screenshot({ path: `${shots}/tests-ask-ai.png` });
    await page.getByRole("button", { name: "AI Assistant" }).click();
  }

  // The empty input box of a new test shows the format too.
  await panel(page).getByRole("button", { name: "Add test" }).click();
  await expect(panel(page).getByRole("textbox", { name: /^Input/ })).toHaveAttribute("placeholder", "Reads arr: how many, then the values, then n");
  await panel(page).getByRole("button", { name: "Delete test" }).click();

  // Adding the missing value makes it pass.
  await list(page).getByRole("option", { name: /Test 1/ }).click();
  await fillTest(page, "5\n1 2 3 4 5\n4", "3");
  await panel(page).getByRole("button", { name: "Run all" }).click();
  await expect(panel(page).getByText("1 / 1 passed")).toBeVisible({ timeout: 60_000 });
});
