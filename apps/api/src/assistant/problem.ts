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
          "title: short and specific, at most 70 characters, no quotes.",
          "statement: plain text, no markdown symbols (no #, *, `, $, LaTeX). Sections in this order, each heading on its own line followed by its text:",
          "  the task (2-5 sentences, precise, no story padding),",
          "  'Input' (the exact format line by line),",
          "  'Output' (the exact format, including letter case and separators),",
          "  'Constraints' (every bound, one per line, e.g. 1 <= n <= 100000).",
          "  Do NOT include examples in the statement; they are added from the samples.",
          "The answer for every input MUST be unique and fully determined: no 'print any', no floating-point output unless the exact rounding is fixed (e.g. exactly 2 digits after the decimal point), ties broken by an explicit rule.",
          "Interpret the topic as the classic problem an interviewer means by that name (e.g. 'prime number' means deciding whether numbers are prime; 'two sum' means finding two indices whose values add up to a target), unless the topic describes something else.",
          "When the topic is a yes/no or single-value check (e.g. is a number prime), use the format: first line T, then T queries, one answer per line; this makes each test check many cases.",
          "",
          "samples: 2 or 3 (never just 1) small inputs that show the format and a typical case; the candidate sees them. note: one short sentence on what it shows.",
          "edge: 6 to 8 small inputs (each under 2 KB), each aimed at a DIFFERENT mistake a real candidate makes, so that a solution passing all of them is very likely correct. Think first about the wrong solutions candidates write (off-by-one loops, wrong base case, integer overflow in 32-bit languages, sqrt precision, forgetting duplicates, wrong tie-breaking, too slow) and write one input that exposes each. Include: minimum values, maximum values of individual numbers, duplicates, negative numbers or zero if allowed, all-equal values, already sorted and reverse sorted, off-by-one boundaries, special values of the topic (for primes: 0, 1, 2, 3, even numbers, squares of primes, Carmichael numbers, large primes near the bound). With a T-queries format, put the simple values together in one input (e.g. every number from 0 to 30) and spend the other inputs on the hardest traps, several per input. Each input must satisfy the constraints exactly. note: one short sentence naming the trap (e.g. '1 is not prime').",
          "Inputs end with a newline. Use \\n for line breaks inside JSON strings.",
          "",
          "solution: a correct, efficient Python 3 program (standard library only) that reads all of standard input and prints the answer. It must meet the constraints comfortably: use sys.stdin.buffer.read and fast algorithms, and no recursion (use loops and explicit stacks).",
          "brute: a DIFFERENT, obviously correct Python 3 program for the same problem, by the simplest possible method (exhaustive search, direct simulation). It only runs on small inputs, so speed does not matter; correctness does.",
          "validator: a Python 3 program that reads one input from standard input and checks EVERY rule of the Input section and the Constraints strictly with assert: the number of lines and tokens, each value's range, string lengths and alphabets, guarantees such as 'the start cell is empty', and nothing extra at the end. It prints nothing; a failed assert means the input is invalid.",
          "generator: a Python 3 program that reads one integer s from standard input (input(), NOT sys.argv) and prints ONE valid random input of size s (s is the main size parameter, e.g. n or T), using random.seed(s) so the output is repeatable. Every value must satisfy the constraints. The output for the largest size must be under 50000 bytes. Make the inputs hard, not just long: mix random data with the worst cases for slow or wrong solutions (long runs of one letter, long palindromes, all-equal values, sorted and reverse-sorted order, values at the upper bounds, answers far from the start), chosen by s so each size is different.",
          "sizes: three increasing values of s, the largest about 10 times the middle and the middle about 10 times the smallest when the byte limit allows (e.g. [500, 5000, 50000] for small numbers), so running time shows how a solution scales.",
          "",
          "Match the difficulty: easy is one idea and simple loops; medium needs a standard algorithm or data structure (hashing, two pointers, sorting, binary search, prefix sums, BFS); hard needs a careful algorithm (dynamic programming, graphs, greedy with proof, number theory).",
          "Keep the constraints large enough that the naive solution is too slow for medium and hard problems, but inputs must still fit the byte limit.",
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
