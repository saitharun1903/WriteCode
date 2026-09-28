/**
 * The chat renders Markdown, not LaTeX. Models sometimes still write math as
 * `$4 > 3 \rightarrow$`; outside code this turns such spans into plain text
 * with Unicode symbols so they read naturally. Code blocks and inline code are
 * never touched (a `$` in code is code).
 */
const COMMANDS: Record<string, string> = {
  rightarrow: "→",
  to: "→",
  Rightarrow: "⇒",
  leftarrow: "←",
  gets: "←",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  ne: "≠",
  times: "×",
  cdot: "·",
  div: "÷",
  approx: "≈",
  infty: "∞",
  ldots: "…",
  dots: "…",
  in: "∈",
  log: "log",
  lfloor: "⌊",
  rfloor: "⌋",
  text: "",
};

function convert(math: string): string {
  return math
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\(?:mathrm|mathbf|texttt)\{([^}]*)\}/g, "$1")
    .replace(/\\([A-Za-z]+)/g, (m, name: string) => COMMANDS[name] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** A `$...$` span that is math, not two prices or shell variables: it has a LaTeX command or an operator. */
const MATH = /\$([^$\n]{1,80}?)\$/g;
const looksLikeMath = (inner: string) => !/^\s|\s$/.test(inner) && (/\\[A-Za-z]+/.test(inner) || /[<>=+*/^]/.test(inner));

function plainOutsideCode(text: string): string {
  return text.replace(MATH, (whole, inner: string) => (looksLikeMath(inner) ? convert(inner) : whole)).replace(/\\(rightarrow|leftarrow|le|ge|neq|times)\b/g, (m, n: string) => COMMANDS[n] ?? m);
}

export function plainMath(markdown: string): string {
  if (!markdown.includes("$") && !markdown.includes("\\")) return markdown;
  // Split into code (fenced blocks and inline spans) and prose; only prose is changed.
  const parts = markdown.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : plainOutsideCode(part))).join("");
}
