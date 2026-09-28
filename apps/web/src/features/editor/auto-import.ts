/**
 * Imports added on the fly, the way IntelliJ's "add unambiguous imports"
 * works: when code uses a well-known class or module that is not imported yet,
 * the import line is added at the top. Only names with exactly one sensible
 * import are listed, and nothing the project defines itself is ever imported.
 */

const JAVA: Record<string, string> = {};
const add = (pkg: string, names: string) => names.split(" ").forEach((n) => (JAVA[n] = pkg));
add(
  "java.util",
  "Scanner ArrayList List LinkedList Map HashMap TreeMap LinkedHashMap Set HashSet TreeSet LinkedHashSet Queue Deque ArrayDeque PriorityQueue Stack Vector Arrays Collections Iterator ListIterator Random Optional Objects StringJoiner Comparator BitSet NoSuchElementException InputMismatchException StringTokenizer",
);
add("java.util.function", "Function BiFunction Supplier Consumer BiConsumer Predicate BiPredicate UnaryOperator BinaryOperator IntFunction");
add("java.util.stream", "Collectors Stream IntStream LongStream DoubleStream");
add("java.util.concurrent", "ConcurrentHashMap ExecutorService Executors TimeUnit");
add("java.util.concurrent.atomic", "AtomicInteger AtomicLong");
add("java.io", "BufferedReader InputStreamReader IOException PrintWriter BufferedWriter OutputStreamWriter File FileReader FileWriter UncheckedIOException");
add("java.math", "BigInteger BigDecimal RoundingMode");
add("java.time", "LocalDate LocalDateTime LocalTime Duration Instant");
add("java.text", "DecimalFormat");
add("java.nio.file", "Files Path Paths");

/** Python modules used as `module.name`, and names imported from a module. */
const PY_MODULES = ["math", "random", "sys", "time", "string", "itertools", "functools", "heapq", "bisect", "re", "json", "os", "statistics", "copy"];
const PY_FROM: Record<string, string> = {
  deque: "collections",
  defaultdict: "collections",
  Counter: "collections",
  OrderedDict: "collections",
  namedtuple: "collections",
  lru_cache: "functools",
  cache: "functools",
  reduce: "functools",
  dataclass: "dataclasses",
  field: "dataclasses",
  List: "typing",
  Dict: "typing",
  Optional: "typing",
  Tuple: "typing",
};

/** Code with comments and string literals blanked out (same length, so offsets still line up). */
function blank(code: string, language: "java" | "python"): string {
  const pattern =
    language === "java"
      ? /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'/g
      : /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|[rbfu]*"(?:\\.|[^"\\\n])*"|[rbfu]*'(?:\\.|[^'\\\n])*'/gi;
  return code.replace(pattern, (m) => m.replace(/[^\n]/g, " "));
}

export interface ImportEdit {
  /** Lines to insert, in order. */
  lines: string[];
  /** 1-based line to insert before. */
  beforeLine: number;
  /** Also insert an empty line after them (they start a new import block). */
  blankAfter: boolean;
}

/** Word occurrences outside comments and strings, with the offsets where they end. */
function* uses(code: string, name: string): Generator<{ start: number; end: number }> {
  const re = new RegExp(`(?<![\\w.$])${name}(?![\\w$])`, "g");
  for (const m of code.matchAll(re)) yield { start: m.index, end: m.index + name.length };
}

/** A position at the end of this word is still being typed. */
const touches = (use: { start: number; end: number }, cursor?: number) => cursor !== undefined && use.end === cursor;

/**
 * Imports missing from a Java file. `projectCode` is every project file, so
 * classes the user wrote themselves are never imported from the JDK.
 */
export function missingJavaImports(code: string, projectCode: string[], cursor?: number): ImportEdit | null {
  const clean = blank(code, "java");
  const imported = new Set([...clean.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)].map((m) => m[1]!));
  const wildcards = new Set([...clean.matchAll(/^\s*import\s+([\w.]+)\.\*\s*;/gm)].map((m) => m[1]!));
  const own = new Set(projectCode.flatMap((c) => [...blank(c, "java").matchAll(/\b(?:class|interface|enum|record)\s+(\w+)/g)].map((m) => m[1]!)));
  const needed: string[] = [];
  for (const [name, pkg] of Object.entries(JAVA)) {
    if (own.has(name) || wildcards.has(pkg) || imported.has(`${pkg}.${name}`)) continue;
    // Another import already brings in a class of the same simple name (e.g. java.awt.List).
    if ([...imported].some((i) => i.endsWith(`.${name}`))) continue;
    // Not while the name is still being typed (Scan|, List| on the way to ListNode).
    if ([...uses(clean, name)].some((u) => !touches(u, cursor))) needed.push(`import ${pkg}.${name};`);
  }
  if (!needed.length) return null;
  needed.sort();
  const lines = code.split("\n");
  const importLines = lines.map((l, i) => (/^\s*import\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (importLines.length) return { lines: needed, beforeLine: importLines[importLines.length - 1]! + 2, blankAfter: false };
  const pkgLine = lines.findIndex((l) => /^\s*package\s/.test(l));
  if (pkgLine >= 0) return { lines: ["", ...needed], beforeLine: pkgLine + 2, blankAfter: false };
  return { lines: needed, beforeLine: 1, blankAfter: true };
}

/** Imports missing from a Python file: `math.sqrt` needs `import math`, `deque(` needs `from collections import deque`. */
export function missingPythonImports(code: string, cursor?: number): ImportEdit | null {
  const clean = blank(code, "python");
  const has = (re: RegExp) => re.test(clean);
  const needed: string[] = [];
  // Every module named on an `import a, b as c` line.
  const importedModules = new Set(
    [...clean.matchAll(/^\s*import\s+([^\n]+)/gm)].flatMap((m) => m[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]!)),
  );
  for (const mod of PY_MODULES) {
    const imported = importedModules.has(mod);
    const defined = has(new RegExp(`^\\s*(?:def|class)\\s+${mod}\\b|^\\s*${mod}\\s*=`, "m")) || has(new RegExp(`\\bfor\\s+${mod}\\s+in\\b|\\bas\\s+${mod}\\b`));
    if (imported || defined) continue;
    const used = [...clean.matchAll(new RegExp(`(?<![\\w.])${mod}\\.(\\w)`, "g"))].some((m) => cursor === undefined || m.index + mod.length + 1 !== cursor);
    if (used) needed.push(`import ${mod}`);
  }
  const from: Record<string, string[]> = {};
  for (const [name, mod] of Object.entries(PY_FROM)) {
    const imported = has(new RegExp(`^\\s*from\\s+${mod}\\s+import\\s+[^\\n]*\\b${name}\\b`, "m")) || has(new RegExp(`^\\s*from\\s+${mod}\\s+import\\s+\\*`, "m"));
    const defined = has(new RegExp(`^\\s*(?:def|class)\\s+${name}\\b|^\\s*${name}\\s*=|\\bimport\\s+[^\\n]*\\b${name}\\b`, "m"));
    if (imported || defined) continue;
    // Called or used as a decorator: deque(...), @lru_cache, @dataclass.
    const used = [...clean.matchAll(new RegExp(`(?<![\\w.])@?${name}(?=\\s*[(\\[\\n])`, "g"))].some((m) => !touches({ start: m.index, end: m.index + m[0].length }, cursor));
    if (used) (from[mod] ??= []).push(name);
  }
  for (const [mod, names] of Object.entries(from)) needed.push(`from ${mod} import ${names.sort().join(", ")}`);
  if (!needed.length) return null;
  const lines = code.split("\n");
  let last = -1;
  for (const [i, l] of lines.entries()) {
    if (/^\s*(?:import|from)\s+\w/.test(l)) last = i;
    else if (l.trim() && !l.trim().startsWith("#") && last >= 0) break;
  }
  if (last >= 0) return { lines: needed, beforeLine: last + 2, blankAfter: false };
  // After a leading shebang or module docstring would be nicer; the top of the file is always valid.
  return { lines: needed, beforeLine: 1, blankAfter: true };
}
