import type { ProjectFile } from "@cw/shared";

/** `a/b/../c` and `./c` as plain project paths; undefined when it leaves the project. */
function resolve(base: string, relative: string): string | undefined {
  const parts = relative.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** The address as written, without its query or fragment; null for one that is not a file of the project (a site, data, a fragment). */
function localPath(page: string, address: string | null): string | undefined {
  if (!address || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(address.trim())) return undefined;
  return resolve(page, decodeURIComponent(address.trim().replace(/[?#].*$/, "")));
}

/**
 * Runs in the previewed page before anything of its own. It sends what the
 * page logs and the errors it throws to the panel around it, gives the page a
 * `localStorage` (a sandboxed page has none: this one lasts until the next
 * run), and turns a link to another page of the project into a request to
 * show that page.
 */
const BRIDGE = `(function () {
  var send = function (m) { try { parent.postMessage(m, "*"); } catch (e) {} };
  var show = function (v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || String(v);
    try { var s = JSON.stringify(v, function (k, x) { return typeof x === "function" ? "[function]" : x === undefined ? "undefined" : x; }, 1); return s === undefined ? String(v) : s.replace(/\\n\\s*/g, " "); } catch (e) { return String(v); }
  };
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var own = console[level];
    console[level] = function () {
      send({ cw: "console", level: level === "debug" ? "log" : level, text: Array.prototype.map.call(arguments, show).join(" ") });
      if (own) own.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    if (e.message) send({ cw: "console", level: "error", text: e.message + (e.lineno ? " (line " + e.lineno + ")" : "") });
    else if (e.target && e.target !== window && (e.target.src || e.target.href)) send({ cw: "console", level: "warn", text: "Could not load " + (e.target.src || e.target.href) });
  }, true);
  window.addEventListener("unhandledrejection", function (e) { send({ cw: "console", level: "error", text: "Uncaught (in promise) " + show(e.reason) }); });
  var memory = function () {
    var data = {};
    return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; }, setItem: function (k, v) { data[k] = String(v); }, removeItem: function (k) { delete data[k]; }, clear: function () { data = {}; }, key: function (i) { return Object.keys(data)[i] || null; }, get length() { return Object.keys(data).length; } };
  };
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { window[name].length; } catch (e) { try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e2) {} }
  });
  var title = null;
  var tell = function () { if (document.title !== title) { title = document.title; send({ cw: "title", text: title }); } };
  document.addEventListener("DOMContentLoaded", tell);
  window.addEventListener("load", tell);
  setInterval(tell, 1000);
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#") { e.preventDefault(); var to = document.getElementById(href.slice(1)); if (to) to.scrollIntoView(); return; }
    if (/^([a-z][a-z0-9+.-]*:|\\/\\/)/i.test(href)) { if (!a.target) a.target = "_blank"; return; }
    e.preventDefault();
    send({ cw: "navigate", href: href });
  }, true);
})();`;

/** Text that can sit inside a <script> element without ending it. */
const inScript = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1");

/**
 * The page a web project shows: `page` (an HTML file of the project) with the
 * project's own stylesheets and scripts put in place of the links to them, so
 * it is one document that needs nothing fetched from the project. Addresses of
 * other sites (a CDN, a font, a picture) are left as they are.
 */
export function buildPreview(files: readonly ProjectFile[], page: string): string {
  const source = files.find((f) => f.path === page)?.content ?? "";
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const doc = new DOMParser().parseFromString(source, "text/html");

  for (const link of [...doc.querySelectorAll("link[href]")]) {
    if (!/\bstylesheet\b/i.test(link.getAttribute("rel") ?? "")) continue;
    const path = localPath(page, link.getAttribute("href"));
    const css = path === undefined ? undefined : byPath.get(path);
    if (css === undefined) continue;
    const style = doc.createElement("style");
    style.setAttribute("data-file", path!);
    const media = link.getAttribute("media");
    if (media) style.setAttribute("media", media);
    // A stylesheet's own @import of another file of the project.
    style.textContent = css.replace(/@import\s+(?:url\()?\s*["']([^"')]+)["']\s*\)?\s*;/g, (all, address: string) => {
      const imported = localPath(path!, address);
      return imported !== undefined && byPath.has(imported) ? byPath.get(imported)! : all;
    });
    link.replaceWith(style);
  }
  for (const script of [...doc.querySelectorAll("script[src]")]) {
    const path = localPath(page, script.getAttribute("src"));
    const code = path === undefined ? undefined : byPath.get(path);
    if (code === undefined) continue;
    script.removeAttribute("src");
    script.setAttribute("data-file", path!);
    script.textContent = inScript(code);
  }

  const bridge = doc.createElement("script");
  bridge.textContent = BRIDGE;
  doc.head.prepend(bridge);
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

/** The project file a link in the previewed page leads to, if it is one of its pages. */
export function linkedPage(files: readonly ProjectFile[], page: string, href: string): string | undefined {
  const path = localPath(page, href);
  return path !== undefined && /\.html?$/i.test(path) && files.some((f) => f.path === path) ? path : undefined;
}

/** The HTML files of a project, in path order. */
export const pagesOf = (files: readonly ProjectFile[]) => files.map((f) => f.path).filter((p) => /\.html?$/i.test(p)).sort();
