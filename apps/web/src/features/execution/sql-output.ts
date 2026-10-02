/**
 * Reads what a SQL run printed (see the runner in @cw/shared, sql-runner.ts)
 * back into its parts: the result tables, the notes about what the other
 * statements did, and any other text.
 */
export type SqlBlock =
  | { kind: "table"; columns: string[]; rows: string[][]; /** False while its last line (`(N rows)`) has not arrived. */ complete: boolean }
  | { kind: "note"; text: string }
  | { kind: "text"; text: string };

const RULE = /^-+(?:-\+-+)*$/;
const COUNT = /^\(\d+ rows?\)$/;

/** One printed line as its cells: ` | ` between them, and `\\`, `\|`, `\n` standing for a backslash, a bar and a line break. */
export function splitCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\" && i + 1 < line.length) {
      const next = line[++i]!;
      cell += next === "n" ? "\n" : next;
    } else if (c === " " && (line.startsWith(" | ", i) || (line[i + 1] === "|" && i + 2 === line.length))) {
      // (A line ends ` |` when its last cell is empty: the spaces after it are not printed.)
      cells.push(cell.trimEnd());
      cell = "";
      i += 2;
    } else cell += c;
  }
  cells.push(cell.trimEnd());
  return cells;
}

export function parseSqlOutput(text: string): SqlBlock[] {
  const lines = text.split("\n");
  // A last line without its line break is still arriving.
  const partial = text.endsWith("\n") ? null : lines.pop();
  if (partial === null) lines.pop();
  const blocks: SqlBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line !== "" && RULE.test(lines[i + 1] ?? "") && splitCells(line).length === (lines[i + 1]!.match(/\+/g)?.length ?? 0) + 1) {
      const columns = splitCells(line);
      const rows: string[][] = [];
      let complete = false;
      let k = i + 2;
      for (; k < lines.length; k++) {
        if (COUNT.test(lines[k]!)) {
          complete = true;
          break;
        }
        const cells = splitCells(lines[k]!);
        // A short line is a row whose last cells are empty.
        while (cells.length < columns.length) cells.push("");
        rows.push(cells.slice(0, columns.length));
      }
      blocks.push({ kind: "table", columns, rows, complete });
      // The blank line after a table belongs to it.
      i = complete && lines[k + 1] === "" ? k + 1 : k;
    } else if (line.startsWith("-- ")) blocks.push({ kind: "note", text: line.slice(3) });
    else if (line !== "") {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "text") last.text += "\n" + line;
      else blocks.push({ kind: "text", text: line });
    }
  }
  return blocks;
}

/** True when every value of the column that is not NULL is a number: such a column is set to the right. */
export function isNumeric(rows: readonly string[][], column: number): boolean {
  let any = false;
  for (const row of rows) {
    const v = row[column]!;
    if (v === "NULL") continue;
    if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return false;
    any = true;
  }
  return any;
}
