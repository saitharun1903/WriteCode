import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { cleanSharedCode, cleanTransferProject } from "@cw/shared";
import { highlight, languageOf } from "@/lib/highlight";
import { suggestName } from "@/features/projects/StartScreen";
import { CODE_FORMATS, buildCodeText, buildCodeWordHtml } from "./code-doc";
import { buildCodePdf } from "./code-pdf";
import { QUIET, inFinder, makeQr, qrSvg } from "./qr";

const NL = String.fromCharCode(10);
const text = (...lines: string[]) => lines.join(NL);
const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const kinds = (code: string, language: string) => highlight(code, language).map((line) => line.map((t) => `${t.kind}:${t.text}`));

describe("syntax colouring", () => {
  it("marks keywords, strings, numbers and comments, and loses no character", () => {
    const code = text("def total(items):  # sum", '    return sum(items) + 10  # "not a string"', "", "print('it''s', 0x1F, 3.5e2)");
    const lines = highlight(code, "python");
    expect(lines.map((l) => l.map((t) => t.text).join("")).join(NL)).toBe(code);
    expect(kinds("def f(): # hi", "python")[0]).toEqual(["keyword:def", "plain: f(): ", "comment:# hi"]);
    expect(kinds('x = "a # b" + 42', "python")[0]).toEqual(["plain:x = ", 'string:"a # b"', "plain: + ", "number:42"]);
  });

  it("follows comments and strings across lines", () => {
    const java = kinds(text("/* one", "   two */ int x = 1; // end"), "java");
    expect(java[0]).toEqual(["comment:/* one"]);
    expect(java[1]).toEqual(["comment:   two */", "plain: ", "keyword:int", "plain: x = ", "number:1", "plain:; ", "comment:// end"]);
    const py = kinds(text('s = """a', 'b"""', "y = 1"), "python");
    expect(py[1]).toEqual(['string:b"""']);
    expect(py[2]).toEqual(["plain:y = ", "number:1"]);
  });

  it("an escaped quote does not end a string, and an unclosed one ends with its line", () => {
    expect(kinds(String.raw`s = "a\"b" + c`, "java")[0]).toEqual(["plain:s = ", String.raw`string:"a\"b"`, "plain: + c"]);
    expect(kinds(text('s = "open', "int y;"), "java")[1]).toEqual(["keyword:int", "plain: y;"]);
  });

  it("colours C includes, and knows a file's language from its name", () => {
    expect(kinds("#include <stdio.h>", "c")[0]).toEqual(["keyword:#include", "plain: ", "string:<stdio.h>"]);
    expect(languageOf("src/Main.java")).toBe("java");
    expect(languageOf("notes.txt", "python")).toBe("python");
    expect(highlight("anything at all", undefined)[0]).toEqual([{ text: "anything at all", kind: "plain" }]);
  });
});

describe("code as a PDF", () => {
  const input = {
    name: "Linked List (demo)",
    language: "java",
    entryFile: "Main.java",
    files: [
      { path: "Node.java", content: text("class Node {", "    int value; // the payload", "}") },
      { path: "Main.java", content: text("public class Main {", '    public static void main(String[] args) { System.out.println("hi"); }', "}") },
    ],
    at: Date.UTC(2026, 9, 1),
  };

  it("is a valid document with the frame, every file, line numbers and the watermark on each page", () => {
    const file = latin1(buildCodePdf(input));
    expect(file.startsWith("%PDF-1.4")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(file)![1]);
    const offsets = [...file.slice(xref).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => expect(file.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    for (const m of file.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) expect(file.slice(m.index + m[0].length + Number(m[1]), m.index + m[0].length + Number(m[1]) + 9)).toBe("endstream");
    for (const s of ["Linked List \\(demo\\)", "Main.java", "Node.java", "(WriteCode)", "writecode.in", "Page 1 of 1", "(public)", '("hi")', "// the payload", "2 files"]) expect(file).toContain(s);
    // The file that runs first comes first.
    expect(file.indexOf("(Main.java)")).toBeLessThan(file.indexOf("(Node.java)"));
  });

  it("wraps long lines and continues long files on new pages, each with the watermark", () => {
    const long = Array.from({ length: 180 }, (_, i) => `x${i} = ${"1 + ".repeat(40)}0`).join(NL);
    const file = latin1(buildCodePdf({ ...input, language: "python", entryFile: "main.py", files: [{ path: "main.py", content: long }] }));
    const pages = Number(/\/Count (\d+)/.exec(file)![1]);
    expect(pages).toBeGreaterThan(3);
    expect(file.split("(WriteCode)").length - 1).toBe(pages);
    expect(file).toContain(`Page ${pages} of ${pages}`);
  });

  it("carries the logo when it is given", () => {
    const logo = { width: 2, height: 2, rgb: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 40, 41, 92]) };
    const file = latin1(buildCodePdf({ ...input, logo }));
    expect(file).toContain("/Subtype /Image /Width 2 /Height 2");
    expect(file).toContain("/Im1 Do");
    const xref = Number(/startxref\n(\d+)/.exec(file)![1]);
    const offsets = [...file.slice(xref).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    offsets.forEach((offset, i) => expect(file.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});

describe("the code to scan", () => {
  /** The code as a camera would see it: dark dots on white, the middle left empty for the logo. */
  function scan(link: string): string | undefined {
    const qr = makeQr(link);
    const scale = 6;
    const side = (qr.size + QUIET * 2) * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        if (!qr.dark(Math.floor(y / scale) - QUIET, Math.floor(x / scale) - QUIET)) continue;
        const i = (y * side + x) * 4;
        pixels[i] = 47;
        pixels[i + 1] = 79;
        pixels[i + 2] = 216;
      }
    }
    return jsQR(pixels, side, side)?.data;
  }

  it("reads back as the link, with the middle left clear for the logo", () => {
    for (const link of ["https://writecode.in/get#abcdefghijklmnopqrstuvwx", "https://writecode.in/share#0123456789abcdef", "http://localhost:3000/get#ABCDEFGHIJKLMNOPQRSTUVWX"]) {
      expect(scan(link)).toBe(link);
    }
  });

  it("keeps the logo's space small and centred, away from the corner squares", () => {
    const qr = makeQr("https://writecode.in/get#abcdefghijklmnopqrstuvwx");
    const side = qr.hole.to - qr.hole.from;
    expect(qr.hole.from).toBe(qr.size - qr.hole.to);
    expect((side * side) / (qr.size * qr.size)).toBeLessThan(0.07);
    expect(qr.dark(qr.hole.from, qr.hole.from)).toBe(false);
    expect(inFinder(qr.size, 3, 3) && inFinder(qr.size, 3, qr.size - 4) && inFinder(qr.size, qr.size - 4, 3)).toBe(true);
    expect(inFinder(qr.size, qr.size - 4, qr.size - 4) || inFinder(qr.size, qr.hole.from, qr.hole.from)).toBe(false);
  });

  it("draws round dots, three corner squares and the logo", () => {
    const { svg, side } = qrSvg("https://writecode.in/share#0123456789abcdef", "data:image/png;base64,AAAA");
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`);
    expect(svg.split("fill-rule=\"evenodd\"").length - 1).toBe(3);
    expect(svg).toContain('<image href="data:image/png;base64,AAAA"');
    // One colour: the ink of the logo.
    expect(svg).toContain('<g fill="#15161a">');
  });
});

describe("what a link may carry", () => {
  const good = { name: "  My   <b>project</b> ", language: "python", entryFile: "main.py", files: [{ path: "main.py", content: "print(1)" }] };

  it("keeps the code and tidies the name", () => {
    expect(cleanSharedCode(good, 1000)).toEqual({ name: "My bproject/b", language: "python", entryFile: "main.py", files: good.files, createdAt: 1000 });
    // An entry file that is not among the files falls back to the first file.
    expect(cleanSharedCode({ ...good, entryFile: "other.py" })?.entryFile).toBe("main.py");
  });

  it("refuses unsafe paths, unknown languages, duplicates and oversized code", () => {
    expect(cleanSharedCode({ ...good, language: "cobol" })).toBeNull();
    expect(cleanSharedCode({ ...good, files: [{ path: "../etc/passwd", content: "" }] })).toBeNull();
    expect(cleanSharedCode({ ...good, files: [good.files[0], good.files[0]] })).toBeNull();
    expect(cleanSharedCode({ ...good, files: [{ path: "big.py", content: "x".repeat(300_000) }] })).toBeNull();
    expect(cleanSharedCode({ ...good, files: [] })).toBeNull();
    expect(cleanSharedCode(null)).toBeNull();
  });

  it("a moved project keeps its work and leaves behind what belongs to the browser", () => {
    const moved = cleanTransferProject({ ...good, id: "p1", folders: ["src", "../x"], stdin: "5", tests: [{ id: "t1", input: "1", expected: "1" }, { id: "bad id", input: "", expected: "" }], breakpoints: { "main.py": [1] }, interview: { secret: true }, createdAt: 10, updatedAt: 20, lastRunAt: 30 }, 1_000);
    expect(moved).toEqual({ id: "p1", name: "My bproject/b", language: "python", entryFile: "main.py", files: good.files, folders: ["src"], stdin: "5", tests: [{ id: "t1", input: "1", expected: "1" }], createdAt: 10, updatedAt: 20, lastRunAt: 30 });
    // A date in the future (a wrong clock on the other device) is brought back to now.
    expect(cleanTransferProject({ ...good, id: "p1", updatedAt: 9_999_999 }, 1_000)?.updatedAt).toBe(1_000);
    expect(cleanTransferProject({ ...good, id: "has space" })).toBeNull();
    expect(cleanTransferProject(good)).toBeNull();
  });
});

describe("code as one file, in the chosen format", () => {
  const input = {
    name: "Sorting <demo>",
    language: "cpp",
    entryFile: "main.cpp",
    at: Date.UTC(2026, 0, 5),
    files: [
      { path: "util.h", content: "int twice(int n);\n" },
      { path: "main.cpp", content: '#include "util.h"\nint main() { return twice(2) < 5; }\n' },
    ],
  };

  it("text: only the code, with nothing added to a single file", () => {
    // One file is exactly its code: no title, no date, no product name.
    const one = buildCodeText({ ...input, files: input.files.slice(1) });
    expect(one).toBe('#include "util.h"\nint main() { return twice(2) < 5; }\n');
    // Several files: each under a line with its name, the file that runs first, and nothing else.
    const text = buildCodeText(input);
    expect(text).toBe('===== main.cpp =====\n#include "util.h"\nint main() { return twice(2) < 5; }\n\n===== util.h =====\nint twice(int n);\n');
    for (const added of ["Sorting", "WriteCode", "writecode.in", "lines", "2026"]) expect(text).not.toContain(added);
  });

  it("Word: coloured code that cannot break out of the page, and the watermark", () => {
    const html = buildCodeWordHtml(input);
    expect(html).toContain("<h1");
    expect(html).toContain("Sorting &lt;demo&gt;");
    expect(html).not.toContain("<demo>");
    expect(html).toContain(") &lt; </span>");
    expect(html).toMatch(/font-weight:bold">return<\/span>/);
    expect(html.indexOf(">main.cpp<")).toBeLessThan(html.indexOf(">util.h<"));
    expect(html).toContain("WriteCode");
    expect(html).toContain("writecode.in");
  });

  it("every format is one file with its own extension", () => {
    expect(CODE_FORMATS.map((f) => f.extension)).toEqual(["pdf", "doc", "txt"]);
  });

  it("colours a file by its own language in every project", () => {
    expect(languageOf("util.h", "c")).toBe("c");
    expect(languageOf("util.h", "cpp")).toBe("cpp");
    expect(languageOf("tool.py", "java")).toBe("python");
    expect(languageOf("main.mts", "javascript")).toBe("typescript");
    expect(languageOf("notes.txt", "java")).toBe("java");
  });
});

describe("a new project's name", () => {
  it("suggests one that is not taken", () => {
    expect(suggestName("Java project", [])).toBe("Java project");
    expect(suggestName("Java project", ["java project", "Java project 2 "])).toBe("Java project 3");
  });
});
