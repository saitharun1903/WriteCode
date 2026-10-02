"use client";

import { Check } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { isNumeric, parseSqlOutput, type SqlBlock } from "./sql-output";

/** Rows drawn at once; a longer result says how many more there are (the whole of it is in Copy output). */
const MAX_ROWS = 500;

function ResultTable({ block, index }: { block: Extract<SqlBlock, { kind: "table" }>; index: number }) {
  const numeric = useMemo(() => block.columns.map((_, c) => isNumeric(block.rows, c)), [block]);
  const shown = block.rows.slice(0, MAX_ROWS);
  return (
    <figure className="my-2.5 max-w-full font-sans">
      <div className="inline-block max-w-full overflow-x-auto rounded-lg border border-line-strong bg-surface align-top">
        <table aria-label={`Result ${index}`} className="border-collapse text-left text-[13px] leading-5">
          <thead>
            <tr className="bg-surface-3">
              {block.columns.map((c, i) => (
                <th key={i} scope="col" className={cn("whitespace-nowrap border-b border-line-strong px-3 py-1.5 font-semibold text-fg", i > 0 && "border-l border-line", numeric[i] && "text-right")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono text-[12.5px]">
            {shown.map((row, r) => (
              <tr key={r} className="even:bg-surface-2 hover:bg-hover">
                {row.map((v, i) => (
                  <td key={i} className={cn("max-w-[28rem] whitespace-pre-wrap break-words border-t border-line px-3 py-1 align-top text-fg", i > 0 && "border-l", numeric[i] && "text-right tabular-nums", v === "NULL" && "italic text-fg-faint")}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
            {block.rows.length === 0 && block.complete && (
              <tr>
                <td colSpan={block.columns.length} className="border-t border-line px-3 py-2 font-sans text-[13px] text-fg-subtle">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-1 text-xs text-fg-subtle">
        {block.complete ? `${block.rows.length} row${block.rows.length === 1 ? "" : "s"}` : "Loading…"}
        {block.rows.length > MAX_ROWS && ` · the first ${MAX_ROWS} are shown`}
      </figcaption>
    </figure>
  );
}

/** The output of a SQL run: each query's rows as a table, with a line for what the other statements did. */
export function SqlResults({ text }: { text: string }) {
  const blocks = useMemo(() => parseSqlOutput(text), [text]);
  let table = 0;
  return (
    <div>
      {blocks.map((b, i) =>
        b.kind === "table" ? (
          <ResultTable key={i} block={b} index={++table} />
        ) : b.kind === "note" ? (
          <p key={i} className="flex items-center gap-1.5 font-sans text-[13px] leading-6 text-fg-muted">
            <Check className="size-3.5 shrink-0 text-success" />
            {b.text}
          </p>
        ) : (
          <pre key={i} className="whitespace-pre-wrap font-mono text-[13px] text-fg">
            {b.text}
          </pre>
        ),
      )}
    </div>
  );
}
