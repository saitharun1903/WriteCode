import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingIncludes } from "./auto-import";

/**
 * Takes C/C++ programs (VERIFY_INCLUDES=<dir> of .c/.cpp files), removes their
 * includes, adds back what `missingIncludes` finds, and compiles them in gcc:14
 * with implicit declarations as errors: every program must compile again.
 */
const dir = process.env.VERIFY_INCLUDES;
const files = dir ? readdirSync(dir).filter((f) => /\.(c|cpp)$/.test(f)) : [];

describe.skipIf(!dir)("missing includes compile again", () => {
  it.each(files)("%s", { timeout: 120_000 }, (file) => {
    const cpp = file.endsWith(".cpp");
    const stripped = readFileSync(join(dir!, file), "utf8").replace(/^\s*#\s*include[^\n]*\n/gm, "");
    const edit = missingIncludes(stripped, cpp);
    const lines = stripped.split("\n");
    if (edit) lines.splice(edit.beforeLine - 1, 0, ...edit.lines, ...(edit.blankAfter ? [""] : []));
    const work = mkdtempSync(join(tmpdir(), "cw-inc-"));
    writeFileSync(join(work, file), lines.join("\n"));
    const cmd = cpp ? `g++ -std=c++20 -fsyntax-only ${file}` : `gcc -std=c17 -Werror=implicit-function-declaration -fsyntax-only ${file}`;
    let errors = "";
    try {
      execFileSync("docker", ["run", "--rm", "-v", `${work}:/w`, "-w", "/w", "gcc:14", "sh", "-c", cmd], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      errors = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(errors, `${file} with ${edit?.lines.join(" ")}`).toBe("");
  });
});
