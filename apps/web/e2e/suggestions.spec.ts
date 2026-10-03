import { expect, test, type Page } from "@playwright/test";

/**
 * Suggestions while typing in every language, and the switch in Settings that
 * turns the AI assistant off everywhere. Needs only the web app.
 */

const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const suggestions = (page: Page) => page.locator(".monaco-editor .suggest-widget.visible .monaco-list-row");

async function freshProject(page: Page, language: string) {
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
  if (!(await tile.isVisible())) await page.getByRole("button", { name: "More languages" }).click();
  await tile.click();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await editor(page).waitFor();
  await page.waitForFunction(() => (window as unknown as { monaco?: { editor: { getEditors(): unknown[] } } }).monaco?.editor.getEditors().length);
}

/** Replaces the file with `code`, puts the cursor at its end, then types `typed` key by key. */
async function typeAtEnd(page: Page, code: string, typed: string) {
  await page.evaluate((text) => {
    type Ed = { getModel(): { setValue(v: string): void; getLineCount(): number; getLineMaxColumn(n: number): number }; setPosition(p: { lineNumber: number; column: number }): void; focus(): void };
    const ed = (window as unknown as { monaco: { editor: { getEditors(): Ed[] } } }).monaco.editor.getEditors()[0]!;
    const m = ed.getModel();
    m.setValue(text);
    const line = m.getLineCount();
    ed.setPosition({ lineNumber: line, column: m.getLineMaxColumn(line) });
    ed.focus();
  }, code);
  await page.keyboard.type(typed, { delay: 60 });
}

// [language, the code before the cursor, what is typed, a suggestion that must be offered]
const CASES: [string, string, string, string][] = [
  ["Java", "class Main {\n    void f() {\n        ", "Math.ma", "max"],
  ["Java", "class Main {\n    void f() {\n        ", "sou", "sout"],
  ["Python", "import math\n", "math.sq", "sqrt"],
  ["Python", "", "enum", "enumerate"],
  ["C++", "#include <bits/stdc++.h>\nint main() {\n    std::vector<int> v;\n    ", "v.push", "push_back"],
  ["C", "#include <stdio.h>\nint main(void) {\n    ", "prin", "printf"],
  ["JavaScript", "", "conso", "console"],
  ["TypeScript", "", "forof", "forof"],
  ["Kotlin", "fun main() {\n    ", "prin", "println"],
  ["Go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\t', "fmt.Pri", "Println"],
  ["Rust", "fn main() {\n    let s = ", "String::n", "new"],
  ["C#", "class Program {\n    static void Main() {\n        ", "Console.Wri", "WriteLine"],
  ["PHP", "<?php\n", "str_re", "str_replace"],
  ["Ruby", "", "put", "puts"],
  ["Bash", "#!/bin/bash\n", "ech", "echo"],
  ["SQL", "", "sel", "SELECT"],
  ["HTML, CSS, JS", "", "html", "html5"],
];

test("suggestions while typing, in every language: keywords, functions, members and snippets", async ({ page }) => {
  test.setTimeout(240_000);
  let open = "";
  for (const [language, code, typed, expected] of CASES) {
    if (language !== open) {
      await freshProject(page, language);
      open = language;
    }
    await typeAtEnd(page, code, typed);
    await expect(suggestions(page).filter({ hasText: expected }).first(), `${language}: "${typed}" offers ${expected}`).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
  }
});

test("a suggestion is inserted with its parameters as Tab stops", async ({ page }) => {
  await freshProject(page, "Python");
  await typeAtEnd(page, "import math\n", "math.gc");
  await expect(suggestions(page).filter({ hasText: "gcd" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  // The first parameter is selected: typing replaces it, Tab moves to the next.
  await page.keyboard.type("12");
  await page.keyboard.press("Tab");
  await page.keyboard.type("18");
  await expect(editor(page)).toContainText("math.gcd(12, 18)");
});

test("no suggestions pop up inside a string or a comment", async ({ page }) => {
  await freshProject(page, "Python");
  await typeAtEnd(page, "", 'print("enum');
  await page.waitForTimeout(800);
  await expect(suggestions(page).filter({ hasText: "enumerate" })).toHaveCount(0);
});

test("with Suggestions while typing off, nothing pops up; Ctrl+Space still shows them", async ({ page }) => {
  await freshProject(page, "Go");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Coding help" }).click();
  await dialog.getByRole("switch", { name: "Suggestions while typing" }).click();
  await page.keyboard.press("Escape");
  await typeAtEnd(page, 'package main\n\nimport "fmt"\n\nfunc main() {\n\t', "fmt.Pr");
  await page.waitForTimeout(800);
  await expect(suggestions(page)).toHaveCount(0);
  await page.keyboard.press("Control+Space");
  await expect(suggestions(page).filter({ hasText: "Println" }).first()).toBeVisible();
});

test("turning the AI assistant off in Settings removes it everywhere, and on brings it back", async ({ page }) => {
  await freshProject(page, "Python");
  await expect(page.getByRole("button", { name: "AI Assistant" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Coding help" }).click();
  const ai = dialog.getByRole("switch", { name: "AI assistant" });
  await expect(ai).toHaveAttribute("aria-checked", "true");
  await ai.click();
  await expect(ai).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");

  // No Ask AI button, and its shortcut does nothing.
  await expect(page.getByRole("button", { name: "AI Assistant" })).toHaveCount(0);
  await editor(page).click();
  await page.keyboard.press("Control+Shift+A");
  await expect(page.getByRole("region", { name: "AI Assistant" })).toHaveCount(0);
  // Nor in the editor's right-click menu.
  await editor(page).click({ button: "right" });
  await expect(page.locator(".monaco-menu").getByText("Ask AI: Find Bugs in This File")).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Nor in the command list.
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Ask AI");
  await expect(page.getByRole("option", { name: /Ask AI to Find Bugs/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The choice is kept after a reload.
  await page.reload();
  await editor(page).waitFor();
  await expect(page.getByRole("button", { name: "AI Assistant" })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Coding help" }).click();
  await page.getByRole("dialog", { name: "Settings" }).getByRole("switch", { name: "AI assistant" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "AI Assistant" })).toBeVisible();
});
