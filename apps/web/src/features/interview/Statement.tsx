"use client";

import { Fragment } from "react";

export type StatementBlock = { kind: "text"; text: string } | { kind: "heading"; text: string } | { kind: "example"; title: string; rows: { label: string; text: string }[]; note?: string };

const HEADING = /^(input( format)?|output( format)?|constraints?|notes?|explanation|examples?|follow[- ]up|task|problem)\s*:?$/i;
const EXAMPLE = /^(example|sample)( input| test)?\s*\d*\s*:?$/i;
const ROW = /^(input|output|expected output|explanation)\s*:\s*(.*)$/i;

/**
 * Splits a plain-text problem statement into paragraphs, headings ("Constraints")
 * and examples (their Input and Output shown as blocks), the way a judge lays a
 * problem out. Text that fits none of these stays a paragraph, line breaks kept.
 */
export function parseStatement(statement: string): StatementBlock[] {
  const blocks: StatementBlock[] = [];
  for (const part of statement.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = part.split("\n");
    const first = lines[0]!.trim();
    if (!part.trim()) continue;
    if (EXAMPLE.test(first)) {
      const rows: { label: string; text: string }[] = [];
      for (const line of lines.slice(1)) {
        const m = ROW.exec(line.trim());
        if (m) rows.push({ label: m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase(), text: m[2]! });
        else if (rows.length) rows[rows.length - 1]!.text += (rows[rows.length - 1]!.text ? "\n" : "") + line;
        else rows.push({ label: "", text: line });
      }
      blocks.push({ kind: "example", title: first.replace(/:$/, ""), rows });
      continue;
    }
    const last = blocks.at(-1);
    // A lone paragraph straight after an example explains it.
    if (last?.kind === "example" && !last.note && !HEADING.test(first) && lines.length <= 3 && !/^(input|output)\b/i.test(first)) {
      last.note = part.trim();
      continue;
    }
    if (HEADING.test(first)) {
      blocks.push({ kind: "heading", text: first.replace(/:$/, "") });
      if (lines.length > 1) blocks.push({ kind: "text", text: lines.slice(1).join("\n") });
      continue;
    }
    blocks.push({ kind: "text", text: part });
  }
  return blocks;
}

/** The problem statement, laid out for reading. It cannot be selected: copying it out is not part of an interview. */
export function Statement({ text }: { text: string }) {
  const blocks = parseStatement(text);
  return (
    <div className="select-none space-y-4 text-[14px] leading-relaxed text-fg">
      {blocks.map((b, i) =>
        b.kind === "heading" ? (
          <h4 key={i} className="pt-1 text-[14px] font-semibold text-fg">
            {b.text}:
          </h4>
        ) : b.kind === "text" ? (
          <p key={i} className="whitespace-pre-wrap text-fg-muted">
            {b.text}
          </p>
        ) : (
          <div key={i}>
            <h4 className="mb-2 text-[14px] font-semibold text-fg">{b.title}:</h4>
            <div className="space-y-1 border-l-2 border-line-strong pl-4 font-mono text-[13px]">
              {b.rows.map((r, j) => (
                <Fragment key={j}>
                  {r.label && <div className="font-semibold text-fg">{r.label}:</div>}
                  <pre className="whitespace-pre-wrap break-words text-fg-muted">{r.text}</pre>
                </Fragment>
              ))}
              {b.note && <p className="pt-1 font-sans text-[13px] text-fg-muted">{b.note}</p>}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
