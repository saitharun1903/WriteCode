import { describe, expect, it } from "vitest";
import { parseProblem, problemPrompt } from "./problem.js";

const reply = {
  title: '"Primality"',
  statement: "Decide.\r\n\r\nInput\nT then T lines.",
  samples: [{ input: "1\n2", note: "2 is prime" }, { input: "  ", note: "blank" }],
  edge: [{ input: "1\n1\n", note: "1 is not prime" }, "junk"],
  solution: "print('YES')",
  brute: "print('YES')",
  validator: "assert True",
  generator: "print(1)",
  sizes: [5000, 50, 500, 500, -1, 1.5, "x"],
};

describe("interview problem replies", () => {
  it("reads and tidies a reply, even with text around the JSON", () => {
    const p = parseProblem(`Here it is:\n${JSON.stringify(reply)}\nDone.`)!;
    expect(p.title).toBe("Primality");
    expect(p.statement).toBe("Decide.\n\nInput\nT then T lines.");
    expect(p.samples).toEqual([{ input: "1\n2\n", note: "2 is prime" }]);
    expect(p.edge).toEqual([{ input: "1\n1\n", note: "1 is not prime" }]);
    expect(p.sizes).toEqual([50, 500, 5000]);
    expect(p.validator).toBe("assert True");
  });

  it("rejects replies without the essentials", () => {
    expect(parseProblem("no json")).toBeNull();
    expect(parseProblem("{broken")).toBeNull();
    expect(parseProblem(JSON.stringify({ ...reply, solution: "" }))).toBeNull();
    expect(parseProblem(JSON.stringify({ ...reply, samples: [] }))).toBeNull();
  });

  it("asks for the topic and difficulty", () => {
    const { contents, systemInstruction } = problemPrompt("prime numbers", "hard");
    expect(contents[0]!.parts[0]!.text).toBe("Topic: prime numbers\nDifficulty: hard");
    expect(systemInstruction.parts[0]!.text).toContain("validator");
  });
});
