import type { GeneratedProblem, ProblemDifficulty } from "@cw/shared";

/**
 * Writes a complete interview problem from a short topic ("prime number",
 * "longest substring without repeats"): the statement, sample and edge-case
 * inputs, and three small Python programs. The expected outputs are NOT taken
 * from the model: the browser runs the reference solution on every input in
 * the sandbox, checks it against the brute-force solution on the small ones,
 * and keeps only the tests both agree on.
 */
export function problemPrompt(topic: string, difficulty: ProblemDifficulty) {
  const systemInstruction = {
    parts: [
      {
        text: [
          "You write coding-interview problems, like a careful problem setter for a programming contest.",
          "The candidate's program reads from standard input and writes to standard output, in any language.",
          "",
          "Reply with ONLY one JSON object, no markdown fences, with exactly these fields:",
          '{"title": string, "statement": string, "samples": [{"input": string, "note": string}], "edge": [{"input": string, "note": string}], "solution": string, "brute": string, "validator": string, "generator": string, "sizes": [number, number, number]}',
          "",
          "title: the name the problem is known by, at most 70 characters, no quotes (e.g. 'Two Sum', 'Longest Substring Without Repeating Characters').",
          "statement: written for the CANDIDATE, who has never seen the problem. They must be able to solve it from the statement alone, so write it the way the best online judges do: short sentences, everyday words, every term explained the first time it is used, and no rule left for them to guess.",
          "  Plain text, no markdown symbols (no #, *, `, $, LaTeX). Sections in this order, each heading alone on its own line followed by its text, with one blank line between sections:",
          "  the task, with no heading (2-5 sentences): what is given and exactly what to find. Say what the numbers MEAN (e.g. 'the price of a stock on day i'), not just their names. State every rule that decides the answer: what counts as different, what to do when there are several answers, what to print when there is none.",
          "  'Input': one sentence per line of input, in order: what is on it, how many values, and how they are separated (e.g. 'The first line has two integers n and target.' then 'The second line has n integers, the numbers of the array, separated by spaces.').",
          "  'Output': exactly what to print and on how many lines, including separators, letter case, and the exact word to print when there is no answer.",
          "  'Constraints': every bound, one per line, in the form 1 <= n <= 100000, and any guarantee (e.g. 'Exactly one answer exists.').",
          "  Do NOT include examples in the statement; they are added from the samples.",
          "Keep the input format as simple as the problem allows: ONE problem instance per input (first the size, then the data). Do not wrap the problem in 'T test cases' unless the task is a yes/no or single-value check on one number or string (e.g. is a number prime), where 'first line T, then T queries, one answer per line' lets each test check many values.",
          "The answer for every input MUST be unique and fully determined: no 'print any', no floating-point output unless the exact rounding is fixed (e.g. exactly 2 digits after the decimal point). Prefer a natural output that needs no tie-breaking (a count, a sum, a length, the values in sorted order, YES/NO); when a tie-break is needed, state it in one plain sentence.",
          "When the output lists several items, the statement fixes their exact order (e.g. 'print each triplet with its numbers in increasing order, and the triplets in increasing order'); never write that the order does not matter, because the output is compared exactly.",
          "Interpret the topic as the classic problem an interviewer means by that name (e.g. 'prime number' means deciding whether numbers are prime; 'two sum' means finding two indices whose values add up to a target; '3 sum' means finding triplets that add up to zero), unless the topic describes something else. Keep the classic problem recognisable; do not replace it with an unusual variant.",
          "",
          "Difficulty changes the problem itself, not just the numbers. For the same topic, the three levels must be three different problems:",
          "  easy: the simplest version of the topic, one idea, solved with plain loops. Small bounds (n up to about 1000) so that a straightforward solution is fast enough. No tricky cases in the statement.",
          "  medium: the standard interview version. Bounds large enough (n up to about 100000 when the algorithm allows) that the obvious slow solution fails, so it needs the standard technique (hashing, two pointers, sorting, binary search, prefix sums, a stack, BFS).",
          "  hard: a harder version of the topic: an extra requirement or generalisation that needs a careful algorithm (dynamic programming, graphs, greedy with a proof, number theory, advanced data structures), with large bounds and edge cases that break careless solutions.",
          "",
          "samples: 2 or 3 (never just 1) small inputs that show the format and a typical case; the candidate sees them. note: an explanation of that example in one or two plain sentences, walking through WHY the answer is what it is using the actual values (e.g. 'The numbers at positions 0 and 1 are 2 and 7, and 2 + 7 = 9.'). Check the arithmetic; the note must agree with the correct answer. Do not put the heading 'Explanation' in the note.",
          "edge: 5 or 6 small inputs (each under 2 KB), each aimed at a DIFFERENT mistake a real candidate makes, so that a solution passing all of them is very likely correct. Think first about the wrong solutions candidates write (off-by-one loops, wrong base case, integer overflow in 32-bit languages, forgetting duplicates, wrong tie-breaking, too slow) and write one input that exposes each. Cover: minimum sizes, largest allowed values, duplicates, negative numbers or zero if allowed, all-equal values, and the special values of the topic. With a T-queries format, put the simple values together in one input and spend the others on the hardest traps. Each input must satisfy the constraints exactly. note: one short sentence naming the trap (e.g. '1 is not prime').",
          "Inputs end with a newline. Use \\n for line breaks inside JSON strings.",
          "",
          "solution: a correct, efficient Python 3 program (standard library only) that reads all of standard input and prints the answer. It must meet the constraints comfortably: use sys.stdin.buffer.read and fast algorithms, and no recursion (use loops and explicit stacks).",
          "brute: a DIFFERENT, obviously correct Python 3 program for the same problem, by the simplest possible method (exhaustive search, direct simulation). It only runs on small inputs, so speed does not matter; correctness does.",
          "validator: a Python 3 program that reads one input from standard input and checks EVERY rule of the Input section and the Constraints strictly with assert: the number of lines and tokens, each value's range, string lengths and alphabets, guarantees such as 'the start cell is empty', and nothing extra at the end. It prints nothing; a failed assert means the input is invalid.",
          "generator: a Python 3 program that reads one integer s from standard input (input(), NOT sys.argv) and prints ONE valid random input of size s (s is the main size parameter, e.g. n or T), using random.seed(s) so the output is repeatable. Every value must satisfy the constraints. The output for the largest size must be under 50000 bytes. Make the inputs hard, not just long: mix random data with the worst cases for slow or wrong solutions (long runs of one letter, long palindromes, all-equal values, sorted and reverse-sorted order, values at the upper bounds, answers far from the start), chosen by s so each size is different.",
          "sizes: three increasing values of s, the largest about 10 times the middle and the middle about 10 times the smallest when the byte limit allows (e.g. [500, 5000, 50000] for small numbers), so running time shows how a solution scales.",
          "",
          "Keep every program short and plain: no comments, no unused code.",
        ].join("\n"),
      },
    ],
  };
  const contents = [{ role: "user" as const, parts: [{ text: `Topic: ${topic}\nDifficulty: ${difficulty}` }] }];
  return { systemInstruction, contents };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").slice(0, max) : "");

function tests(v: unknown, max: number): { input: string; note: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, max)
    .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>) : {}))
    .map((t) => {
      const input = text(t.input, 4096);
      return { input: input && !input.endsWith("\n") ? `${input}\n` : input, note: text(t.note, 160).trim() };
    })
    .filter((t) => t.input.trim());
}

/** Reads the model's reply; null when it is unusable. */
export function parseProblem(reply: string): GeneratedProblem | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sizes = Array.isArray(raw.sizes) ? raw.sizes.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 10_000_000) : [];
  const p: GeneratedProblem = {
    title: text(raw.title, 120).replace(/^["']|["']$/g, "").trim(),
    statement: text(raw.statement, 8000).trim(),
    samples: tests(raw.samples, 3),
    edge: tests(raw.edge, 8),
    solution: text(raw.solution, 20_000),
    brute: text(raw.brute, 20_000),
    validator: text(raw.validator, 20_000),
    generator: text(raw.generator, 20_000),
    sizes: [...new Set(sizes)].sort((a, b) => a - b).slice(0, 3),
  };
  if (!p.title || !p.statement || !p.solution.trim() || !p.samples.length) return null;
  return p;
}
