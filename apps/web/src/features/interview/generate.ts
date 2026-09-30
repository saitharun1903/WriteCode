"use client";

import { TEST_LIMITS, type ExecutionResult, type GeneratedProblem, type InterviewTest, type ProblemDifficulty } from "@cw/shared";
import { API_URL } from "@/features/execution/api";
import { compareOutput, outputLines } from "@/features/tests/compare";
import { createId } from "@/lib/id";
import { runTests } from "./store";

export interface PreparedProblem {
  title: string;
  /** The statement with the samples added as examples. */
  statement: string;
  samples: InterviewTest[];
  hidden: InterviewTest[];
  /** The reference solution the expected outputs came from (Python 3). */
  solution: string;
}

export type Step = "writing" | "checking" | "large";

/** Printed instead of an answer when the validator rejects the input. */
export const INVALID = "__INVALID_INPUT__";

/**
 * Runs the Python files around it with the test's input on a fresh standard
 * input each (text and bytes both work), and the input as argv[1] too, for a
 * generator that reads its size from there. With validate.py, an input that
 * fails an assert (or cannot even be parsed) prints INVALID instead of an
 * answer; a validator that breaks in some other way is ignored.
 */
const RUNNER = `import contextlib, io, os, runpy, sys
data = sys.stdin.buffer.read()
def run(path):
    sys.stdin = io.TextIOWrapper(io.BytesIO(data), encoding="utf-8")
    sys.argv = [path, data.decode("utf-8", "replace").strip()]
    runpy.run_path(path, run_name="__main__")
if os.path.exists("validate.py"):
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            run("validate.py")
    except (AssertionError, ValueError, IndexError, EOFError) as e:
        print("${INVALID}", str(e)[:200])
        sys.exit(0)
    except SystemExit as e:
        if e.code not in (None, 0):
            print("${INVALID}", str(e.code)[:200])
            sys.exit(0)
    except Exception:
        pass
run("program.py")
`;

const python = (code: string, validator = "") => ({
  language: "python",
  files: [{ path: "main.py", content: RUNNER }, { path: "program.py", content: code }, ...(validator.trim() ? [{ path: "validate.py", content: validator }] : [])],
  entry: "main.py",
});
const tidy = (stdout: string) => `${outputLines(stdout).join("\n")}\n`;
/** Output this close to the per-test cap may have been cut short. */
const MAX_GENERATED = TEST_LIMITS.maxOutputBytesPerTest - 1024;

/** The server refused or failed: asking again straight away would not help. */
class ServerError extends Error {}

async function fetchProblem(topic: string, difficulty: ProblemDifficulty, signal: AbortSignal): Promise<GeneratedProblem> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/v1/assistant/interview-problem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, difficulty }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ServerError("Could not reach the server.");
  }
  const body = (await res.json().catch(() => ({}))) as GeneratedProblem & { message?: string };
  if (!res.ok) throw new ServerError(body.message ?? `Request failed (${res.status})`);
  return body;
}

const byIndex = (r: ExecutionResult | undefined, i: number) => r?.tests?.find((t) => t.index === i);

/**
 * The statement's examples, from the verified samples, so the examples can
 * never disagree with the tests.
 */
export function withExamples(statement: string, samples: { input: string; expected: string; note?: string }[]): string {
  const examples = samples.map((s, i) =>
    [`Example ${i + 1}`, "Input:", s.input.replace(/\n$/, ""), "Output:", s.expected.replace(/\n$/, ""), ...(s.note ? ["", s.note] : [])].join("\n"),
  );
  return [statement.trim(), ...examples].join("\n\n");
}

interface Checked {
  tests: InterviewTest[];
  /** Small tests where the two solutions gave different answers. */
  disagreements: number;
  compared: number;
  /** Small tests the validator rejected. */
  invalid: number;
}

/**
 * Keeps a small test when the reference solution ran and either agrees with
 * the brute-force solution or the brute force was too slow to say.
 */
export function checkSmall(inputs: { input: string; note: string }[], solution: ExecutionResult, brute: ExecutionResult | undefined): Checked {
  const tests: InterviewTest[] = [];
  let disagreements = 0;
  let compared = 0;
  let invalid = 0;
  inputs.forEach((t, i) => {
    const s = byIndex(solution, i);
    if (s?.status !== "SUCCESS" || !s.stdout.trim()) return;
    if (s.stdout.startsWith(INVALID)) {
      invalid++;
      return;
    }
    const b = byIndex(brute, i);
    if (b?.status === "SUCCESS") {
      compared++;
      if (!compareOutput(b.stdout, s.stdout).pass) {
        disagreements++;
        return;
      }
    }
    tests.push({ id: createId(), input: t.input, expected: tidy(s.stdout), ...(t.note ? { note: t.note } : {}) });
  });
  return { tests, disagreements, compared, invalid };
}

async function prepareOnce(topic: string, difficulty: ProblemDifficulty, onStep: (s: Step) => void, signal: AbortSignal): Promise<PreparedProblem & { trust: number }> {
  onStep("writing");
  const p = await fetchProblem(topic, difficulty, signal);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  // Room for the large tests in the one execution that runs the reference solution.
  const sizes = p.generator.trim() ? p.sizes.slice(0, 3) : [];
  const samples = p.samples.slice(0, 3);
  const edge = p.edge.slice(0, TEST_LIMITS.maxTests - samples.length - sizes.length);
  const small = [...samples, ...edge];

  onStep("checking");
  const [solutionSmall, generated] = await Promise.all([
    runTests(python(p.solution, p.validator), small.map((t) => t.input)),
    sizes.length ? runTests(python(p.generator), sizes.map((s) => `${s}\n`)).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const large = sizes.flatMap((size, i) => {
    const g = byIndex(generated, i);
    return g?.status === "SUCCESS" && g.stdout.trim() && new TextEncoder().encode(g.stdout).length < MAX_GENERATED ? [{ size, input: g.stdout.endsWith("\n") ? g.stdout : `${g.stdout}\n` }] : [];
  });

  onStep("large");
  const [brute, solutionLarge] = await Promise.all([
    p.brute.trim() ? runTests(python(p.brute), small.map((t) => t.input)).catch(() => undefined) : Promise.resolve(undefined),
    large.length ? runTests(python(p.solution, p.validator), large.map((t) => t.input)).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");

  const checked = checkSmall(small, solutionSmall, brute);
  const sampleTests = checked.tests.filter((t) => samples.some((s) => s.input === t.input));
  const edgeTests = checked.tests.filter((t) => !sampleTests.includes(t));
  const largeTests: InterviewTest[] = large.flatMap((t, i) => {
    const s = byIndex(solutionLarge, i);
    return s?.status === "SUCCESS" && s.stdout.trim() && !s.stdout.startsWith(INVALID) ? [{ id: createId(), input: t.input, expected: tidy(s.stdout), note: `Large input, size ${t.size.toLocaleString("en-US")}` }] : [];
  });

  return {
    title: p.title,
    statement: withExamples(p.statement, sampleTests),
    samples: sampleTests,
    hidden: [...edgeTests, ...largeTests],
    solution: p.solution,
    // Disagreeing solutions and inputs that break the problem's own rules both suggest a muddled problem.
    trust: small.length ? (checked.tests.length - (checked.compared ? 0 : checked.tests.length / 2)) / small.length : 0,
  };
}

/**
 * Writes a problem from a topic and computes every expected output by running
 * the reference solution in the sandbox, cross-checked by a brute-force
 * solution. A problem whose checks disagree too often is written again once.
 */
export async function prepareProblem(topic: string, difficulty: ProblemDifficulty, onStep: (s: Step) => void, signal: AbortSignal): Promise<PreparedProblem> {
  let best: (PreparedProblem & { trust: number }) | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await prepareOnce(topic, difficulty, onStep, signal).catch((e: unknown) => {
      // A run that failed (a broken program, a busy runner) is worth one more try.
      if (signal.aborted || e instanceof ServerError || attempt === 1) {
        if (best) return null;
        throw e;
      }
      return null;
    });
    if (p && (!best || p.trust > best.trust)) best = p;
    if (best && best.trust >= 0.7 && best.samples.length && best.hidden.length >= 3) break;
  }
  if (!best || !best.samples.length) throw new Error("The problem's answers could not be checked. Try again, or describe it in a few more words.");
  return { title: best.title, statement: best.statement, samples: best.samples, hidden: best.hidden, solution: best.solution };
}
