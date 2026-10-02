import { describe, expect, it } from "vitest";
import { isNumeric, parseSqlOutput, splitCells } from "./sql-output";

describe("what a SQL run printed, read back", () => {
  it("reads tables, notes and the cells' escapes", () => {
    const text = [
      "-- Table students created",
      "-- 3 rows inserted into students",
      "id | name    | marks",
      "---+---------+------",
      "1  | Asha    | 91.5",
      "2  | Mee\\|ra | NULL",
      "3  | two\\nlines |",
      "(3 rows)",
      "",
      "n",
      "-",
      "0",
      "(1 row)",
      "",
      "-- 1 row updated in students",
      "",
    ].join("\n");
    expect(parseSqlOutput(text)).toEqual([
      { kind: "note", text: "Table students created" },
      { kind: "note", text: "3 rows inserted into students" },
      { kind: "table", columns: ["id", "name", "marks"], rows: [["1", "Asha", "91.5"], ["2", "Mee|ra", "NULL"], ["3", "two\nlines", ""]], complete: true },
      { kind: "table", columns: ["n"], rows: [["0"]], complete: true },
      { kind: "note", text: "1 row updated in students" },
    ]);
  });

  it("a table still arriving is shown as far as it has come", () => {
    const blocks = parseSqlOutput("a | b\n--+--\n1 | 2\n3 | 4");
    expect(blocks).toEqual([{ kind: "table", columns: ["a", "b"], rows: [["1", "2"]], complete: false }]);
  });

  it("an empty result is a table with its columns and no rows; other text stays text", () => {
    expect(parseSqlOutput("name\n----\n(0 rows)\n\nhello\nworld\n")).toEqual([
      { kind: "table", columns: ["name"], rows: [], complete: true },
      { kind: "text", text: "hello\nworld" },
    ]);
    // A line of dashes under text that is not a header of as many columns is not a table.
    expect(parseSqlOutput("a | b\n---\n")[0]!.kind).toBe("text");
  });

  it("splits on the bars that separate, not the ones in a value", () => {
    expect(splitCells("a\\\\ | b \\| c | ")).toEqual(["a\\", "b | c", ""]);
    expect(isNumeric([["1"], ["NULL"], ["-2.5"]], 0)).toBe(true);
    expect(isNumeric([["1"], ["x"]], 0)).toBe(false);
    expect(isNumeric([["NULL"]], 0)).toBe(false);
  });
});
