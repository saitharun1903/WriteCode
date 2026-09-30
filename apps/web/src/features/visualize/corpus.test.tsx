import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Trace } from "@cw/shared";
import { analyzeTrace, detectWithCoverage, stableKeys, structureTitle, type Structure, type TreeNode } from "./concepts";
import { ConceptView } from "./ConceptView";
import { diffSteps, isCallable, withSourceTypeNames } from "./model";

/**
 * Replays recorded traces of real programs (VIZ_CORPUS=<dir>, written by the
 * worker's corpus test) through the structure view, step by step: nothing may
 * throw, every drawn element needs a unique identity for its animation, and
 * every object a variable holds must be drawn somewhere.
 */
const dir = process.env.VIZ_CORPUS;
const traces = dir ? readdirSync(join(dir, "traces")).filter((f) => f.endsWith(".json") && !f.endsWith(".result.json")) : [];

function treeKeys(n: TreeNode | null, out: string[] = []): string[] {
  if (!n) return out;
  out.push(n.key);
  n.children.forEach((c) => treeKeys(c, out));
  return out;
}

const unique = (xs: string[]) => new Set(xs).size === xs.length;

describe.skipIf(!dir)("structure view on recorded programs", () => {
  const summary: string[] = [];
  it.each(traces)("%s", { timeout: 180_000 }, (file) => {
    const trace: Trace = withSourceTypeNames(JSON.parse(readFileSync(join(dir!, "traces", file), "utf8")) as Trace);
    const seenKinds = new Set<string>();
    const hints = analyzeTrace(trace);
    trace.steps.forEach((step, i) => {
      const where = `${file} step ${i + 1}`;
      const { structures, consumed } = detectWithCoverage(step, hints);
      const cards = structures.map((s) => `${s.kind}:${s.id}:${s.name}`);
      expect(unique(cards), `${where}: duplicate cards ${cards}`).toBe(true);
      for (const s of structures) {
        seenKinds.add(`${structureTitle(s)} ${s.name}`);
        checkStructure(trace, i, s, where);
      }
      // Every object a variable holds is drawn: as a structure, inside one, or as an object card.
      for (const f of step.frames)
        for (const [name, v] of f.locals) {
          if (v.kind !== "ref") continue;
          const o = step.heap[v.id];
          if (!o || o.kind === "other" || isCallable(o)) continue;
          if (name === "args" && o.type === "String[]") continue;
          expect(consumed.has(v.id), `${where}: ${name} (${o.type}) is not drawn`).toBe(true);
        }
      if (i < 400 || i % 7 === 0) {
        const html = renderToString(<ConceptView trace={trace} stepIndex={i} diff={diffSteps(trace, i)} />);
        expect(html.length, where).toBeGreaterThan(0);
      }
    });
    summary.push(`${file.padEnd(22)} ${trace.steps.length} steps: ${[...seenKinds].join(" | ")}`);
  });

  it("summary", () => {
    if (process.env.VIZ_SUMMARY) writeFileSync(process.env.VIZ_SUMMARY, summary.join("\n"));
  });
});

function checkStructure(trace: Trace, i: number, s: Structure, where: string) {
  const at = `${where} ${s.kind} ${s.name}`;
  switch (s.kind) {
    case "array":
      if (!s.chars) {
        const keys = stableKeys(trace, s.id, i);
        expect(unique(keys), `${at}: keys ${keys}`).toBe(true);
        expect(keys.length, at).toBe(s.items.length);
      }
      break;
    case "stack":
    case "queue": {
      const keys = stableKeys(trace, s.id, i);
      expect(unique(keys), `${at}: keys`).toBe(true);
      expect(keys.length, at).toBe(s.items.length);
      break;
    }
    case "hash":
      expect(unique(s.entries.map(([k]) => JSON.stringify(k))), `${at}: keys`).toBe(true);
      break;
    case "list":
      expect(unique(s.nodes.map((n) => n.id)), `${at}: nodes`).toBe(true);
      break;
    case "tree": {
      const keys = treeKeys(s.root);
      expect(unique(keys), `${at}: nodes`).toBe(true);
      if (s.items) expect(unique(stableKeys(trace, s.id, i)), `${at}: array keys`).toBe(true);
      break;
    }
    case "graph": {
      const keys = s.nodes.map((n) => n.key);
      expect(unique(keys), `${at}: nodes`).toBe(true);
      for (const e of s.edges) expect(keys.includes(e.from) && keys.includes(e.to), `${at}: edge ${e.from}->${e.to}`).toBe(true);
      break;
    }
    case "matrix":
      expect(unique(s.rows.map((r) => r.id)), `${at}: rows`).toBe(true);
      break;
    default:
      break;
  }
}
