/**
 * Imports (and C/C++ includes) added on the fly, the way IntelliJ's "add unambiguous imports"
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

// -- C and C++ includes

/** Header for each well-known name. C functions and macros are used bare in both languages. */
const C_HEADERS: Record<string, string> = {};
const C_TO_CPP: Record<string, string> = {
  "stdio.h": "cstdio",
  "stdlib.h": "cstdlib",
  "string.h": "cstring",
  "math.h": "cmath",
  "ctype.h": "cctype",
  "limits.h": "climits",
  "time.h": "ctime",
  "stdint.h": "cstdint",
  "assert.h": "cassert",
};
const cHeader = (header: string, names: string) => names.split(" ").forEach((n) => (C_HEADERS[n] = header));
cHeader("stdio.h", "printf scanf puts putchar getchar fgets fputs fprintf sprintf snprintf sscanf fopen fclose fflush FILE EOF stdin stdout stderr");
cHeader("stdlib.h", "malloc calloc realloc free exit atoi atol atof strtol qsort bsearch rand srand abs labs llabs");
cHeader("string.h", "strlen strcpy strncpy strcmp strncmp strcat strncat memset memcpy memmove memcmp strchr strrchr strstr strtok strdup");
cHeader("math.h", "sqrt pow fabs floor ceil round log log2 log10 exp sin cos tan atan atan2 hypot fmod");
cHeader("ctype.h", "isdigit isalpha isalnum isspace isupper islower ispunct toupper tolower");
cHeader("limits.h", "INT_MAX INT_MIN LONG_MAX LONG_MIN LLONG_MAX LLONG_MIN UINT_MAX CHAR_MAX");
cHeader("time.h", "time clock CLOCKS_PER_SEC");
cHeader("stdint.h", "int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t INT64_MAX");
cHeader("assert.h", "assert");
/** C's own spelling of bool (C17 needs the header). */
const C_ONLY: Record<string, string> = { bool: "stdbool.h", true: "stdbool.h", false: "stdbool.h" };

/** C++ standard names (used as `std::name`, or bare after `using namespace std;`). */
const CPP_HEADERS: Record<string, string> = {};
const cppHeader = (header: string, names: string) => names.split(" ").forEach((n) => (CPP_HEADERS[n] = header));
cppHeader("iostream", "cout cin cerr endl");
cppHeader("vector", "vector");
cppHeader("string", "string to_string stoi stol stoll stod getline");
cppHeader("map", "map multimap");
cppHeader("unordered_map", "unordered_map");
cppHeader("set", "set multiset");
cppHeader("unordered_set", "unordered_set");
cppHeader("queue", "queue priority_queue");
cppHeader("stack", "stack");
cppHeader("deque", "deque");
cppHeader("list", "list");
cppHeader("array", "array");
cppHeader("bitset", "bitset");
cppHeader("tuple", "tuple make_tuple tie get");
cppHeader("utility", "pair make_pair swap move");
cppHeader("algorithm", "sort stable_sort reverse max min max_element min_element find find_if count count_if binary_search lower_bound upper_bound next_permutation prev_permutation unique fill transform all_of any_of none_of");
cppHeader("numeric", "accumulate iota gcd lcm partial_sum");
cppHeader("functional", "greater less function");
cppHeader("iomanip", "setprecision fixed setw setfill");
cppHeader("sstream", "stringstream istringstream ostringstream");
cppHeader("memory", "unique_ptr shared_ptr make_unique make_shared");
cppHeader("climits", "numeric_limits");

function blankC(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Includes missing from a C or C++ file: `printf` needs <stdio.h> (<cstdio> in
 * C++), `std::vector` needs <vector>. In C++ a bare name counts only after
 * `using namespace std;`. Nothing is added next to <bits/stdc++.h>, and names
 * the program defines itself are left alone.
 */
export function missingIncludes(code: string, cpp: boolean, cursor?: number): ImportEdit | null {
  const clean = blankC(code);
  const included = new Set([...code.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]!.trim()));
  if (included.has("bits/stdc++.h")) return null;
  const usingStd = /\busing\s+namespace\s+std\s*;/.test(clean);
  const defined = (name: string) =>
    new RegExp(`\\b(?:struct|class|union|enum|typedef[^;]*|#\\s*define)\\s+${name}\\b|\\b${name}\\s*\\([^;{)]*\\)\\s*(?:const\\s*)?\\{|\\b(?:int|long|double|float|char|void|bool|auto|unsigned|short|size_t|string|[A-Z]\\w*)\\s*[*&]?\\s+${name}\\s*[=;,(\\[)]`).test(clean);
  const needed = new Set<string>();
  const want = (header: string) => {
    if (!included.has(header)) needed.add(header);
  };
  const usedBare = (name: string) => [...uses(clean, name)].some((u) => !touches(u, cursor) && clean[u.start - 1] !== ":" && !/\s*::/.test(clean.slice(u.end, u.end + 3)));
  for (const [name, header] of Object.entries(C_HEADERS)) {
    const h = cpp ? C_TO_CPP[header]! : header;
    if (included.has(header) || included.has(h) || defined(name)) continue;
    // In C++ the C++ header's std:: names count too (std::sqrt).
    const std = cpp && [...clean.matchAll(new RegExp(`\\bstd::${name}(?![\\w$])`, "g"))].some((m) => !touches({ start: m.index, end: m.index + m[0].length }, cursor));
    if (usedBare(name) || std) want(h);
  }
  if (!cpp) {
    for (const [name, header] of Object.entries(C_ONLY)) if (!defined(name) && usedBare(name)) want(header);
  } else {
    for (const [name, header] of Object.entries(CPP_HEADERS)) {
      if (defined(name)) continue;
      const std = [...clean.matchAll(new RegExp(`\\bstd::${name}(?![\\w$])`, "g"))].some((m) => !touches({ start: m.index, end: m.index + m[0].length }, cursor));
      if (std || (usingStd && usedBare(name))) want(header);
    }
  }
  if (!needed.size) return null;
  const lines = code.split("\n");
  const last = lines.reduce((at, l, i) => (/^\s*#\s*include\b/.test(l) ? i : at), -1);
  const text = [...needed].sort().map((h) => `#include <${h}>`);
  if (last >= 0) return { lines: text, beforeLine: last + 2, blankAfter: false };
  return { lines: text, beforeLine: 1, blankAfter: true };
}
