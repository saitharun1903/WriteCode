import { describe, expect, it } from "vitest";
import { buildPreview, linkedPage, pagesOf } from "./build";

const files = [
  { path: "index.html", content: '<!DOCTYPE html><html><head><title>T</title><link rel="stylesheet" href="css/style.css"><link rel="stylesheet" href="https://cdn.example.com/x.css"><link rel="icon" href="favicon.ico"></head><body><h1>Hi</h1><a href="pages/about.html">About</a><script src="./script.js"></script><script src="https://cdn.example.com/lib.js"></script></body></html>' },
  { path: "css/style.css", content: '@import "base.css";\nh1 { color: red; }' },
  { path: "css/base.css", content: "body { margin: 0; }" },
  { path: "script.js", content: 'document.title = "</script><b>";' },
  { path: "pages/about.html", content: '<html><head><link rel="stylesheet" href="../css/style.css"></head><body><a href="../index.html#top">Home</a></body></html>' },
];

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("the page a web project shows", () => {
  it("puts the project's stylesheets and scripts in place of the links to them, and leaves other sites' alone", () => {
    const doc = parse(buildPreview(files, "index.html"));
    const style = doc.querySelector('style[data-file="css/style.css"]')!;
    // A stylesheet's @import of another file of the project comes with it.
    expect(style.textContent).toBe("body { margin: 0; }\nh1 { color: red; }");
    expect(doc.querySelector('link[href="css/style.css"]')).toBeNull();
    expect(doc.querySelector('link[href="https://cdn.example.com/x.css"]')).not.toBeNull();
    expect(doc.querySelector('link[rel="icon"]')).not.toBeNull();
    const script = doc.querySelector('script[data-file="script.js"]')!;
    expect(script.hasAttribute("src")).toBe(false);
    // The code is all there, and a "</script>" inside it did not end the element.
    expect(script.textContent).toBe('document.title = "<\\/script><b>";');
    expect(doc.querySelector('script[src="https://cdn.example.com/lib.js"]')).not.toBeNull();
    expect(doc.querySelector("h1")!.textContent).toBe("Hi");
  });

  it("runs its own script first: the console, storage and links of the page go through it", () => {
    const doc = parse(buildPreview(files, "index.html"));
    const first = doc.head.firstElementChild!;
    expect(first.tagName).toBe("SCRIPT");
    expect(first.textContent).toContain('cw: "console"');
    expect(first.textContent).toContain("localStorage");
  });

  it("finds a page's files from the page's own folder", () => {
    const doc = parse(buildPreview(files, "pages/about.html"));
    expect(doc.querySelector('style[data-file="css/style.css"]')).not.toBeNull();
    expect(linkedPage(files, "pages/about.html", "../index.html#top")).toBe("index.html");
    expect(linkedPage(files, "index.html", "pages/about.html")).toBe("pages/about.html");
    // Not a page of the project: another site, a file that is not there, a way out of the project.
    for (const href of ["https://example.com/a.html", "missing.html", "../../etc.html", "mailto:a@b.c", "script.js"]) expect(linkedPage(files, "index.html", href), href).toBeUndefined();
  });

  it("lists the pages of a project", () => {
    expect(pagesOf(files)).toEqual(["index.html", "pages/about.html"]);
    expect(buildPreview(files, "missing.html")).toContain("<body></body>");
  });
});
