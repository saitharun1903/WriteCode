import { describe, expect, it } from "vitest";
import { LANGUAGES } from "@cw/shared";
import { COMPLETIONS } from "./completions-data";
import { parseEntry, suggestionCount } from "./completions";
import { SNIPPETS } from "./snippets";

describe("parseEntry", () => {
  it("turns a call's parameters into Tab stops", () => {
    expect(parseEntry("max(a, b)")).toMatchObject({ name: "max", signature: "(a, b)", insert: "max(${1:a}, ${2:b})", call: true });
    expect(parseEntry("random()")).toMatchObject({ name: "random", insert: "random()" });
  });

  it("keeps a lambda or closure in one parameter", () => {
    expect(parseEntry("fold(init, |acc, x| acc)").insert).toBe("fold(${1:init}, ${2:|acc, x| acc})");
    expect(parseEntry("Select(x => x)").insert).toBe("Select(${1:x => x})");
  });

  it("writes a block after the call, with its body as a Tab stop", () => {
    expect(parseEntry("map { it }").insert).toBe("map { ${1:it} }");
    expect(parseEntry("repeat(times) { }").insert).toBe("repeat(${1:times}) { $0 }");
  });

  it("escapes what snippets treat as syntax: PHP variables, braces", () => {
    expect(parseEntry("count($array)").insert).toBe("count(${1:\\$array})");
    expect(parseEntry('println!("{}", x)').insert).toBe('println!(${1:"{\\}"}, ${2:x})');
  });

  it("leaves names and constants as they are", () => {
    expect(parseEntry("MAX_VALUE")).toMatchObject({ name: "MAX_VALUE", insert: "MAX_VALUE", call: false });
  });
});

describe("suggestions in every language", () => {
  it("every language has keywords, functions or snippets", () => {
    for (const lang of LANGUAGES) {
      const ids = lang.monacoLanguage === "html" ? ["html", "css", "javascript"] : [lang.monacoLanguage];
      for (const id of ids) expect(suggestionCount(id), `${lang.name} (${id})`).toBeGreaterThan(5);
    }
  });

  it("every entry has a name, and every snippet a prefix and a body", () => {
    for (const [id, data] of Object.entries(COMPLETIONS)) {
      const entries = [...data.builtins, ...data.methods, ...Object.values(data.members).flat()];
      for (const e of entries) {
        const text = typeof e === "string" ? e : e[0];
        expect(parseEntry(text).name, `${id}: ${text}`).toMatch(/^[\w$!?:.]+$/);
      }
    }
    for (const [id, snippets] of Object.entries(SNIPPETS)) {
      const prefixes = snippets.map((s) => s.prefix);
      expect(new Set(prefixes).size, `${id} has a prefix twice`).toBe(prefixes.length);
      for (const s of snippets) expect(s.body.length, `${id}: ${s.prefix}`).toBeGreaterThan(0);
    }
  });
});
