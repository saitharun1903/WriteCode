import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readInputFor } from "./read-input";

/**
 * Runs each rewritten program in its real image with the input the rewrite
 * produced: it must print exactly what the original printed. Needs Docker;
 * run with VERIFY_READ_INPUT=1.
 */
const CASES: [string, string, string, string][] = [
  [
    "c",
    "main.c",
    "gcc:14",
    `#include <stdio.h>

int main(void) {
    int n = 4;
    double rate = 2.5;
    char grade = 'B';
    int arr[] = {5, 1, 9, 3};
    long long big = 12345678901;
    int sum = 0;
    for (int i = 0; i < n; i++) sum += arr[i];
    printf("%d %.1f %c %lld %d\\n", sum, rate, grade, big, (int)(sizeof(arr) / sizeof(arr[0])));
    return 0;
}
`,
  ],
  [
    "cpp",
    "main.cpp",
    "gcc:14",
    `#include <iostream>
#include <string>
#include <vector>
using namespace std;

int main() {
    int k = 3;
    string name = "ada";
    vector<int> nums = {4, 8, 15, 16};
    int arr[3] = {7, 8, 9};
    int total = 0;
    for (int x : nums) total += x;
    cout << k << " " << name << " " << total << " " << nums.size() << " " << arr[2] << endl;
    return 0;
}
`,
  ],
  [
    "javascript",
    "main.js",
    "node:22-slim",
    `const n = 3;
const name = "ada";
const nums = [2, 4, 6];
function sum(xs) {
  const inner = 10;
  return xs.reduce((a, b) => a + b, 0) + inner;
}
console.log(n, name, sum(nums), nums.length);
`,
  ],
  [
    "typescript",
    "main.ts",
    "node:22-slim",
    `const limit: number = 5;
const words: string[] = ["x", "y"];
const scores = [1.5, 2.5];
console.log(limit * 2, words.join("-"), scores[1]);
`,
  ],
];

const run = (image: string, dir: string, file: string, stdin: string) => {
  const cmd = file.endsWith(".c")
    ? `gcc -std=c17 -O2 -Wall -o /tmp/m ${file} -lm && /tmp/m`
    : file.endsWith(".cpp")
      ? `g++ -std=c++20 -O2 -Wall -o /tmp/m ${file} && /tmp/m`
      : file.endsWith(".ts")
        ? `node --experimental-transform-types --no-warnings ${file}`
        : `node ${file}`;
  return execFileSync("docker", ["run", "--rm", "-i", "-v", `${dir}:/w`, "-w", "/w", image, "sh", "-c", cmd], { input: stdin, encoding: "utf8" });
};

describe.skipIf(!process.env.VERIFY_READ_INPUT)("read input: same output as before", () => {
  it.each(CASES)("%s", { timeout: 120_000 }, (language, file, image, code) => {
    const result = readInputFor(language, code);
    expect(result, "nothing rewritten").toBeTruthy();
    const dir = mkdtempSync(join(tmpdir(), "cw-ri-"));
    writeFileSync(join(dir, file), code);
    const before = run(image, dir, file, "");
    writeFileSync(join(dir, file), result!.code);
    const after = run(image, dir, file, result!.input);
    expect(after).toBe(before);
  });
});
