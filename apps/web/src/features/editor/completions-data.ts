/**
 * What the editor suggests while typing, for every language: its keywords, the
 * built-in functions and types people reach for, and the members of the
 * modules and classes they use most (after `Math.`, `fmt.`, `std::`...).
 *
 * An entry is `"name(param, other)"` or `"name"`, with an optional note:
 * `["sqrt(x)", "Square root of x"]`. A call's parameters become Tab stops.
 */

export type Entry = string | [string] | [string, string];

export interface LanguageCompletions {
  keywords: string[];
  /** Names usable anywhere: functions, types, constants, modules. */
  builtins: Entry[];
  /** Members after a known receiver: `Math` -> `Math.max(a, b)`. */
  members: Record<string, Entry[]>;
  /** Methods offered after any other value (`xs.` for a list, `s.` for a string...). */
  methods: Entry[];
  /** How members are reached, besides `.`. */
  access?: ("::" | "->")[];
}

const JAVA: LanguageCompletions = {
  keywords: "abstract assert boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public record return short static super switch this throw throws try var void while true false".split(" "),
  builtins: [
    ["System", "Standard input, output and the clock"], ["String", "Text"], ["Scanner", "Reads input: new Scanner(System.in)"], ["StringBuilder", "Builds text piece by piece"],
    ["Math", "abs, max, min, pow, sqrt..."], ["Arrays", "sort, fill, toString for arrays"], ["Collections", "sort, reverse, max for lists"],
    ["ArrayList", "A growable list"], ["LinkedList", "A doubly linked list"], ["HashMap", "Key to value, unordered"], ["TreeMap", "Key to value, sorted by key"],
    ["HashSet", "Unique values, unordered"], ["TreeSet", "Unique values, sorted"], ["ArrayDeque", "Stack and queue"], ["PriorityQueue", "Smallest first (a heap)"],
    ["List", "List.of(...)"], ["Map", "Map.of(...)"], ["Set", "Set.of(...)"], ["Queue", "First in, first out"], ["Deque", "Both ends"], ["Iterator", "Walks a collection"],
    ["Integer", "parseInt, MAX_VALUE..."], ["Long", "parseLong, MAX_VALUE..."], ["Double", "parseDouble..."], ["Character", "isDigit, isLetter..."], ["Boolean", "true or false"],
    ["Optional", "A value that may be missing"], ["Objects", "equals, hash, requireNonNull"], ["Random", "Random numbers"], ["BufferedReader", "Fast line input"],
    ["InputStreamReader", "Wraps System.in for BufferedReader"], ["Collectors", "toList, joining, groupingBy"], ["Exception", "Base of errors you catch"],
    ["RuntimeException", "An unchecked error"], ["IllegalArgumentException", "A bad argument"], ["Thread", "Runs code in parallel"],
  ],
  members: {
    "System.out": [["println(x)", "Print x, then a new line"], ["print(x)", "Print x"], ["printf(format, args)", "Print with a format: %d %s %.2f %n"]],
    "System.err": [["println(x)", "Print x to the error stream"]],
    System: ["out", "in", "err", ["currentTimeMillis()", "Milliseconds since 1970"], ["nanoTime()", "A precise clock for timing"], ["exit(status)", "Stop the program"], ["arraycopy(src, srcPos, dest, destPos, length)", "Copy part of an array"]],
    Math: [["abs(x)", "Absolute value"], ["max(a, b)", "The larger"], ["min(a, b)", "The smaller"], ["pow(a, b)", "a to the power b"], ["sqrt(x)", "Square root"], ["cbrt(x)", "Cube root"], ["floor(x)", "Round down"], ["ceil(x)", "Round up"], ["round(x)", "Nearest whole number"], ["random()", "A number in [0, 1)"], ["hypot(x, y)", "sqrt(x² + y²)"], ["log(x)", "Natural log"], ["log10(x)", "Log base 10"], ["floorDiv(a, b)", "Division rounded down"], ["floorMod(a, b)", "Remainder, never negative"], ["signum(x)", "-1, 0 or 1"], ["toRadians(deg)", "Degrees to radians"], ["sin(a)"], ["cos(a)"], ["tan(a)"], ["PI", "π"], ["E", "e"]],
    Arrays: [["sort(a)", "Sort in place"], ["fill(a, value)", "Set every element"], ["toString(a)", "[1, 2, 3]"], ["deepToString(a)", "For 2D arrays"], ["asList(items)", "A fixed-size list"], ["stream(a)", "A stream of the elements"], ["copyOf(a, length)", "A copy, cut or padded"], ["copyOfRange(a, from, to)", "Part of an array"], ["binarySearch(a, key)", "Index in a sorted array"], ["equals(a, b)", "Same elements?"]],
    Collections: [["sort(list)", "Sort in place"], ["reverse(list)", "Reverse in place"], ["max(c)", "Largest"], ["min(c)", "Smallest"], ["shuffle(list)", "Random order"], ["swap(list, i, j)", "Swap two positions"], ["frequency(c, x)", "How many times x appears"], ["reverseOrder()", "A comparator, largest first"], ["unmodifiableList(list)", "A read-only view"], ["emptyList()", "An empty list"], ["nCopies(n, x)", "n copies of x"]],
    Integer: [["parseInt(s)", "Text to int"], ["valueOf(x)", "Boxed Integer"], ["toString(x)", "int to text"], ["toBinaryString(x)", "In base 2"], ["bitCount(x)", "Number of 1 bits"], ["compare(a, b)", "-1, 0 or 1"], ["MAX_VALUE", "2147483647"], ["MIN_VALUE", "-2147483648"], ["sum(a, b)"]],
    Long: [["parseLong(s)", "Text to long"], ["valueOf(x)"], ["toString(x)"], ["MAX_VALUE"], ["MIN_VALUE"], ["compare(a, b)"]],
    Double: [["parseDouble(s)", "Text to double"], ["valueOf(x)"], ["compare(a, b)"], ["MAX_VALUE"], ["MIN_VALUE"], ["isNaN(x)"]],
    Character: [["isDigit(c)"], ["isLetter(c)"], ["isLetterOrDigit(c)"], ["isUpperCase(c)"], ["isLowerCase(c)"], ["isWhitespace(c)"], ["toUpperCase(c)"], ["toLowerCase(c)"], ["getNumericValue(c)", "'7' -> 7"]],
    String: [["valueOf(x)", "Anything to text"], ["join(delimiter, items)", "Join with a separator"], ["format(format, args)", "Text from a format"]],
    List: [["of(items)", "An unmodifiable list"], ["copyOf(c)"]],
    Set: [["of(items)", "An unmodifiable set"]],
    Map: [["of(k1, v1)", "An unmodifiable map"], ["entry(key, value)"]],
    Objects: [["equals(a, b)", "Null-safe equals"], ["hash(values)", "A hash of several values"], ["requireNonNull(x)", "Throws if x is null"], ["isNull(x)"]],
    Collectors: [["toList()"], ["toSet()"], ["joining(delimiter)", "Join strings"], ["groupingBy(classifier)", "Group into a map"], ["counting()"], ["toMap(keyMapper, valueMapper)"]],
    Thread: [["sleep(millis)", "Pause this thread"]],
  },
  methods: [
    ["length()", "Characters in a string"], ["charAt(index)", "Character at a position"], ["substring(begin, end)", "Part of a string"], ["indexOf(x)", "First position of x, or -1"], ["contains(x)", "Has x?"],
    ["equals(other)", "Same value?"], ["equalsIgnoreCase(other)"], ["compareTo(other)", "Negative, zero or positive"], ["toUpperCase()"], ["toLowerCase()"], ["trim()", "Without spaces at the ends"], ["strip()"],
    ["split(regex)", "Break into an array"], ["isEmpty()"], ["isBlank()"], ["startsWith(prefix)"], ["endsWith(suffix)"], ["replace(target, replacement)"], ["toCharArray()"], ["chars()"], ["repeat(count)"],
    ["size()", "Number of elements"], ["add(x)", "Append"], ["get(index)", "Element at a position"], ["set(index, x)", "Replace at a position"], ["remove(x)"], ["clear()"], ["addAll(c)"], ["sort(comparator)"],
    ["put(key, value)", "Set a map entry"], ["getOrDefault(key, fallback)", "Value, or fallback when missing"], ["containsKey(key)"], ["containsValue(value)"], ["keySet()"], ["values()"], ["entrySet()"], ["putIfAbsent(key, value)"], ["merge(key, value, remapping)", "map.merge(k, 1, Integer::sum) counts"],
    ["getKey()"], ["getValue()"], ["push(x)", "Onto the stack"], ["pop()", "Off the stack"], ["peek()", "Look without removing"], ["poll()", "Take from the queue"], ["offer(x)", "Add to the queue"],
    ["addFirst(x)"], ["addLast(x)"], ["pollFirst()"], ["pollLast()"], ["peekFirst()"], ["peekLast()"],
    ["nextInt()", "Read an int"], ["nextLong()"], ["nextDouble()"], ["next()", "Read a word"], ["nextLine()", "Read a line"], ["hasNext()"], ["hasNextInt()"], ["readLine()", "BufferedReader: a line, or null at the end"],
    ["stream()"], ["forEach(action)"], ["map(mapper)"], ["filter(predicate)"], ["collect(collector)"], ["sum()"], ["count()"], ["toList()"], ["mapToInt(mapper)"], ["boxed()"],
    ["append(x)", "StringBuilder: add to the end"], ["insert(offset, x)"], ["reverse()"], ["setLength(n)"], ["deleteCharAt(index)"], ["toString()"], ["hashCode()"], ["getClass()"], "length",
  ],
};

const PYTHON: LanguageCompletions = {
  keywords: "and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield".split(" "),
  builtins: [
    ["print(value)", "Print values, then a new line"], ["input(prompt)", "Read a line of input"], ["len(x)", "Number of items"], ["range(stop)", "0, 1, ... stop-1"], ["int(x)", "To a whole number"], ["float(x)", "To a decimal"],
    ["str(x)", "To text"], ["list(items)", "A new list"], ["dict()", "A new dictionary"], ["set(items)", "Unique items"], ["tuple(items)"], ["bool(x)"], ["sorted(items)", "A sorted copy"], ["reversed(items)", "Backwards"],
    ["enumerate(items)", "(index, item) pairs"], ["zip(a, b)", "Pairs from two lists"], ["map(function, items)", "Apply to each"], ["filter(function, items)", "Keep the ones that pass"], ["sum(items)", "Add them up"],
    ["min(items)", "The smallest"], ["max(items)", "The largest"], ["abs(x)"], ["round(x, digits)"], ["pow(base, exp)"], ["divmod(a, b)", "(a // b, a % b)"], ["any(items)", "Is any true?"], ["all(items)", "Are all true?"],
    ["isinstance(x, kind)"], ["type(x)"], ["open(path)", "Open a file"], ["chr(code)", "97 -> 'a'"], ["ord(char)", "'a' -> 97"], ["bin(x)"], ["hex(x)"], ["iter(x)"], ["next(iterator)"], ["hash(x)"], ["id(x)"],
    ["super()"], ["format(value, spec)"], ["frozenset(items)"], ["bytes(x)"], ["object"], ["Exception"], ["ValueError"], ["KeyError"], ["IndexError"], ["TypeError"], ["ZeroDivisionError"], ["RuntimeError"], ["StopIteration"],
    ["math", "Module: sqrt, floor, gcd..."], ["random", "Module: randint, choice..."], ["sys", "Module: stdin, exit..."], ["collections", "Module: Counter, deque, defaultdict"], ["itertools", "Module: permutations, combinations..."],
    ["functools", "Module: lru_cache, reduce"], ["heapq", "Module: a heap on a list"], ["bisect", "Module: binary search on sorted lists"], ["re", "Module: regular expressions"], ["json"], ["time"], ["datetime"], ["string"], ["statistics"], ["os"], ["dataclasses"], ["typing"],
  ],
  members: {
    math: [["sqrt(x)"], ["isqrt(n)", "Whole-number square root"], ["floor(x)"], ["ceil(x)"], ["pow(x, y)"], ["gcd(a, b)"], ["lcm(a, b)"], ["factorial(n)"], ["comb(n, k)", "n choose k"], ["perm(n, k)"], ["log(x)"], ["log2(x)"], ["log10(x)"], ["exp(x)"], ["fabs(x)"], ["hypot(x, y)"], ["prod(items)"], ["isclose(a, b)"], ["sin(x)"], ["cos(x)"], ["tan(x)"], ["radians(deg)"], ["degrees(rad)"], ["pi"], ["e"], ["inf"]],
    random: [["randint(a, b)", "A whole number from a to b"], ["random()", "A number in [0, 1)"], ["choice(items)", "One at random"], ["choices(items, k)"], ["shuffle(items)", "In place"], ["sample(items, k)", "k different items"], ["uniform(a, b)"], ["randrange(stop)"], ["seed(n)"]],
    sys: ["stdin", "stdout", "argv", "maxsize", ["exit(code)"], ["setrecursionlimit(limit)", "Allow deeper recursion"]],
    "sys.stdin": [["readline()", "One line"], ["read()", "Everything"], ["readlines()", "All lines"]],
    collections: [["Counter(items)", "Counts each item"], ["defaultdict(factory)", "A dict with a default"], ["deque(items)", "Fast at both ends"], ["OrderedDict()"], ["namedtuple(name, fields)"]],
    itertools: [["permutations(items, r)"], ["combinations(items, r)"], ["combinations_with_replacement(items, r)"], ["product(a, b)"], ["accumulate(items)", "Running totals"], ["count(start)"], ["cycle(items)"], ["chain(a, b)"], ["groupby(items, key)"], ["islice(items, stop)"], ["pairwise(items)"]],
    functools: [["lru_cache(maxsize=None)", "Remember results (memoize)"], ["cache", "Memoize, no limit"], ["reduce(function, items)"], ["partial(function, args)"], ["cmp_to_key(compare)"]],
    heapq: [["heappush(heap, item)"], ["heappop(heap)", "The smallest"], ["heapify(items)"], ["heappushpop(heap, item)"], ["nlargest(n, items)"], ["nsmallest(n, items)"]],
    bisect: [["bisect_left(a, x)"], ["bisect_right(a, x)"], ["insort(a, x)", "Insert keeping order"]],
    re: [["match(pattern, text)"], ["search(pattern, text)"], ["findall(pattern, text)"], ["sub(pattern, repl, text)"], ["split(pattern, text)"], ["fullmatch(pattern, text)"], ["compile(pattern)"]],
    json: [["dumps(value)", "To JSON text"], ["loads(text)", "From JSON text"], ["dump(value, file)"], ["load(file)"]],
    time: [["time()"], ["sleep(seconds)"], ["perf_counter()", "A precise clock for timing"]],
    os: ["path", "environ", ["getcwd()"], ["listdir(path)"]],
    "os.path": [["join(a, b)"], ["exists(path)"], ["basename(path)"], ["dirname(path)"]],
    string: ["ascii_lowercase", "ascii_uppercase", "ascii_letters", "digits", "punctuation", "whitespace"],
    datetime: ["datetime", "date", "timedelta", "time"],
    statistics: [["mean(items)"], ["median(items)"], ["mode(items)"], ["stdev(items)"]],
  },
  methods: [
    ["append(x)", "Add to the end"], ["extend(items)"], ["insert(index, x)"], ["pop()", "Remove and return the last"], ["remove(x)"], ["sort()", "Sort in place"], ["reverse()"], ["index(x)"], ["count(x)"], ["copy()"], ["clear()"],
    ["split(sep)", "Break text into a list"], ["join(items)", "', '.join(words)"], ["strip()"], ["lstrip()"], ["rstrip()"], ["lower()"], ["upper()"], ["title()"], ["capitalize()"], ["replace(old, new)"],
    ["startswith(prefix)"], ["endswith(suffix)"], ["find(sub)", "Position, or -1"], ["isdigit()"], ["isalpha()"], ["isalnum()"], ["isspace()"], ["isupper()"], ["islower()"], ["zfill(width)"], ["center(width)"], ["splitlines()"], ["format(values)"], ["encode()"],
    ["keys()"], ["values()"], ["items()", "(key, value) pairs"], ["get(key, default)", "Value, or default when missing"], ["setdefault(key, default)"], ["update(other)"],
    ["add(x)", "Add to a set"], ["discard(x)"], ["union(other)"], ["intersection(other)"], ["difference(other)"], ["issubset(other)"],
    ["most_common(n)", "Counter: the n most frequent"], ["appendleft(x)", "deque: add at the front"], ["popleft()", "deque: take from the front"], ["readline()"], ["read()"], ["write(text)"], ["close()"],
  ],
};

const CPP: LanguageCompletions = {
  keywords: "auto bool break case catch char class const constexpr continue default delete do double else enum explicit false float for friend if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while".split(" "),
  builtins: [
    ["cout", "Print: cout << x"], ["cin", "Read: cin >> x"], ["endl", "A new line, and flush"], ["cerr"], ["string", "Text"], ["vector", "A growable array"], ["map", "Sorted key to value"], ["unordered_map", "Hash map"],
    ["set", "Sorted unique values"], ["unordered_set"], ["pair", "Two values"], ["tuple"], ["queue"], ["stack"], ["deque"], ["priority_queue", "Largest first (a heap)"], ["array"], ["bitset"],
    ["sort(first, last)", "Sort a range: sort(v.begin(), v.end())"], ["reverse(first, last)"], ["max(a, b)"], ["min(a, b)"], ["swap(a, b)"], ["accumulate(first, last, init)", "Sum of a range"], ["find(first, last, value)"],
    ["count(first, last, value)"], ["lower_bound(first, last, value)", "First not less than value"], ["upper_bound(first, last, value)"], ["binary_search(first, last, value)"], ["unique(first, last)"], ["next_permutation(first, last)"],
    ["fill(first, last, value)"], ["iota(first, last, start)"], ["min_element(first, last)"], ["max_element(first, last)"], ["abs(x)"], ["sqrt(x)"], ["pow(base, exp)"], ["gcd(a, b)"], ["lcm(a, b)"],
    ["to_string(x)", "Number to text"], ["stoi(s)", "Text to int"], ["stoll(s)"], ["stod(s)"], ["getline(cin, line)", "Read a whole line"], ["make_pair(a, b)"], ["memset(ptr, value, n)"], ["printf(format, args)"], ["scanf(format, args)"],
    ["begin(c)"], ["end(c)"], ["__builtin_popcount(x)", "Number of 1 bits"], ["INT_MAX"], ["INT_MIN"], ["LLONG_MAX"], ["LLONG_MIN"], ["size_t"], ["long long"],
  ],
  members: {
    std: [["cout"], ["cin"], ["endl"], ["string"], ["vector"], ["map"], ["unordered_map"], ["set"], ["pair"], ["sort(first, last)"], ["reverse(first, last)"], ["max(a, b)"], ["min(a, b)"], ["swap(a, b)"], ["to_string(x)"], ["getline(in, line)"], ["accumulate(first, last, init)"], ["move(x)"], ["make_pair(a, b)"], ["numeric_limits"]],
  },
  methods: [
    ["push_back(x)", "Add to the end"], ["emplace_back(args)"], ["pop_back()"], ["size()"], ["empty()"], ["clear()"], ["begin()"], ["end()"], ["rbegin()"], ["rend()"], ["front()"], ["back()"], ["at(index)"],
    ["insert(x)"], ["erase(position)"], ["find(x)"], ["count(x)"], ["resize(n)"], ["reserve(n)"], ["push(x)"], ["pop()"], ["top()"], ["emplace(args)"], ["lower_bound(x)"], ["upper_bound(x)"],
    "first", "second", ["substr(pos, len)", "Part of a string"], ["length()"], ["c_str()"], ["append(s)"], ["compare(s)"], ["contains(x)"],
  ],
  access: ["::", "->"],
};

const C: LanguageCompletions = {
  keywords: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false".split(" "),
  builtins: [
    ["printf(format, args)", "Print with a format: %d %s %.2f\\n"], ["scanf(format, args)", "Read with a format: scanf(\"%d\", &x)"], ["puts(s)"], ["putchar(c)"], ["getchar()"], ["fgets(buffer, size, stdin)", "Read a line"],
    ["malloc(size)", "Memory on the heap"], ["calloc(count, size)", "Zeroed memory"], ["realloc(ptr, size)"], ["free(ptr)"], ["strlen(s)"], ["strcpy(dest, src)"], ["strncpy(dest, src, n)"], ["strcmp(a, b)", "0 when equal"],
    ["strcat(dest, src)"], ["strchr(s, c)"], ["strstr(s, sub)"], ["memset(ptr, value, n)"], ["memcpy(dest, src, n)"], ["abs(x)"], ["sqrt(x)"], ["pow(base, exp)"], ["qsort(base, count, size, compare)"],
    ["atoi(s)"], ["atof(s)"], ["exit(status)"], ["sizeof(x)"], ["isdigit(c)"], ["isalpha(c)"], ["isspace(c)"], ["toupper(c)"], ["tolower(c)"], ["rand()"], ["srand(seed)"], ["time(NULL)"],
    "NULL", "EOF", "INT_MAX", "INT_MIN", "stdin", "stdout", "stderr", "size_t", "FILE",
  ],
  members: {},
  methods: [],
  access: ["->"],
};

const KOTLIN: LanguageCompletions = {
  keywords: "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by catch constructor data enum finally import init lateinit open override private protected public sealed companion internal".split(" "),
  builtins: [
    ["println(message)", "Print, then a new line"], ["print(message)"], ["readln()", "Read a line"], ["readLine()", "A line, or null at the end"], ["readlnOrNull()"], ["listOf(items)"], ["mutableListOf(items)"], ["arrayOf(items)"],
    ["intArrayOf(items)"], ["IntArray(size)"], ["mapOf(pairs)"], ["mutableMapOf(pairs)"], ["hashMapOf(pairs)"], ["setOf(items)"], ["mutableSetOf(items)"], ["maxOf(a, b)"], ["minOf(a, b)"], ["require(condition)"],
    ["check(condition)"], ["error(message)"], ["repeat(times) { }"], ["TODO()"], ["Pair(first, second)"], ["Triple(a, b, c)"], ["ArrayDeque()"], ["StringBuilder()"],
    "String", "Int", "Long", "Double", "Float", "Boolean", "Char", "Unit", "Any", "List", "MutableList", "Map", "MutableMap", "Set", "Array",
    ["abs(x)", "kotlin.math"], ["sqrt(x)", "kotlin.math"], ["min(a, b)", "kotlin.math"], ["max(a, b)", "kotlin.math"],
  ],
  members: {
    Math: [["abs(x)"], ["max(a, b)"], ["min(a, b)"], ["pow(a, b)"], ["sqrt(x)"], ["floor(x)"], ["ceil(x)"], ["PI"]],
    Int: ["MAX_VALUE", "MIN_VALUE"], Long: ["MAX_VALUE", "MIN_VALUE"],
  },
  methods: [
    "size", "length", "indices", "lastIndex", "keys", "values", "entries", "first", "second",
    ["isEmpty()"], ["isNotEmpty()"], ["first()"], ["last()"], ["get(index)"], ["add(x)"], ["remove(x)"], ["removeAt(index)"], ["contains(x)"], ["indexOf(x)"], ["clear()"],
    ["map { it }", "Transform each"], ["filter { it }", "Keep the ones that pass"], ["forEach { }"], ["forEachIndexed { i, x -> }"], ["sum()"], ["sumOf { it }"], ["maxOrNull()"], ["minOrNull()"], ["maxOf { it }"], ["minOf { it }"],
    ["sorted()"], ["sortedBy { it }"], ["sortedDescending()"], ["sortBy { it }"], ["reversed()"], ["joinToString(separator)"], ["toInt()"], ["toLong()"], ["toDouble()"], ["toString()"], ["toCharArray()"],
    ["split(delimiter)"], ["trim()"], ["uppercase()"], ["lowercase()"], ["substring(start, end)"], ["startsWith(prefix)"], ["endsWith(suffix)"], ["replace(old, new)"], ["toList()"], ["toMutableList()"], ["toSet()"],
    ["count { it }"], ["any { it }"], ["all { it }"], ["none { it }"], ["find { it }"], ["groupBy { it }"], ["distinct()"], ["take(n)"], ["drop(n)"], ["chunked(size)"], ["windowed(size)"], ["zip(other)"], ["withIndex()"],
    ["getOrDefault(key, default)"], ["getOrPut(key) { }"], ["containsKey(key)"], ["let { }"], ["also { }"], ["apply { }"], ["run { }"], ["addFirst(x)"], ["addLast(x)"], ["removeFirst()"], ["removeLast()"], ["append(x)"],
  ],
};

const GO: LanguageCompletions = {
  keywords: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota".split(" "),
  builtins: [
    ["len(v)", "Length"], ["cap(v)", "Capacity"], ["append(slice, elems)", "Add to a slice"], ["make(t, size)", "A slice, map or channel"], ["new(t)"], ["delete(m, key)"], ["copy(dst, src)"], ["panic(v)"], ["recover()"],
    ["close(ch)"], ["min(a, b)"], ["max(a, b)"], ["print(args)"], ["println(args)"],
    "int", "int64", "float64", "string", "bool", "byte", "rune", "error", "any",
    ["fmt", "Package: Println, Printf, Scan..."], ["strings", "Package: Split, Join, Contains..."], ["strconv", "Package: Atoi, Itoa..."], ["sort"], ["math"], ["os"], ["bufio", "Package: fast input"], ["errors"], ["time"], ["slices"], ["maps"], ["unicode"],
  ],
  members: {
    fmt: [["Println(a)", "Print, then a new line"], ["Printf(format, a)", "Print with a format: %d %s %v\\n"], ["Print(a)"], ["Sprintf(format, a)", "Text from a format"], ["Sprint(a)"], ["Sprintln(a)"], ["Scan(&x)", "Read values"], ["Scanln(&x)"], ["Scanf(format, &x)"], ["Sscanf(str, format, &x)"], ["Sscan(str, &x)"], ["Errorf(format, a)", "An error with a message"], ["Fprintln(w, a)"], ["Fprintf(w, format, a)"]],
    strings: [["Split(s, sep)"], ["Join(elems, sep)"], ["Contains(s, substr)"], ["HasPrefix(s, prefix)"], ["HasSuffix(s, suffix)"], ["Index(s, substr)"], ["Replace(s, old, new, n)"], ["ReplaceAll(s, old, new)"], ["ToUpper(s)"], ["ToLower(s)"], ["TrimSpace(s)"], ["Trim(s, cutset)"], ["Fields(s)", "Split on spaces"], ["Repeat(s, count)"], ["Count(s, substr)"], ["EqualFold(a, b)"], ["Builder", "Builds text piece by piece"]],
    strconv: [["Itoa(i)", "int to text"], ["Atoi(s)", "Text to int"], ["ParseInt(s, base, bitSize)"], ["ParseFloat(s, bitSize)"], ["FormatInt(i, base)"], ["Quote(s)"]],
    sort: [["Ints(x)"], ["Strings(x)"], ["Float64s(x)"], ["Slice(x, less)", "Sort with a less function"], ["SliceStable(x, less)"], ["SearchInts(a, x)"], ["Search(n, f)"]],
    math: [["Sqrt(x)"], ["Pow(x, y)"], ["Abs(x)"], ["Max(x, y)"], ["Min(x, y)"], ["Floor(x)"], ["Ceil(x)"], ["Round(x)"], ["Mod(x, y)"], ["Inf(sign)"], ["Log(x)"], "Pi", "MaxInt", "MinInt", "MaxInt64", "MinInt64"],
    os: ["Args", "Stdin", "Stdout", "Stderr", ["Exit(code)"], ["ReadFile(name)"]],
    bufio: [["NewReader(os.Stdin)"], ["NewScanner(os.Stdin)", "Read line by line"], ["NewWriter(os.Stdout)", "Fast output; Flush at the end"], "ScanWords", "ScanLines"],
    errors: [["New(text)"], ["Is(err, target)"], ["As(err, target)"]],
    time: [["Now()"], ["Since(t)"], ["Sleep(d)"], "Second", "Millisecond", "Duration"],
    slices: [["Sort(x)"], ["Contains(s, v)"], ["Index(s, v)"], ["Reverse(s)"], ["Max(x)"], ["Min(x)"], ["BinarySearch(x, target)"]],
    maps: [["Keys(m)"], ["Values(m)"]],
    unicode: [["IsDigit(r)"], ["IsLetter(r)"], ["IsUpper(r)"], ["ToUpper(r)"], ["ToLower(r)"]],
  },
  methods: [["Scan()", "Scanner: the next line or word"], ["Text()", "Scanner: what was read"], ["Split(split)"], ["Buffer(buf, max)"], ["ReadString(delim)"], ["WriteString(s)"], ["String()"], ["Len()"], ["Error()"], ["Flush()"], ["Lock()"], ["Unlock()"], ["Add(delta)"], ["Done()"], ["Wait()"]],
};

const RUST: LanguageCompletions = {
  keywords: "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn".split(" "),
  builtins: [
    ["println!(\"{}\", x)", "Print, then a new line"], ["print!(\"{}\", x)"], ["eprintln!(\"{}\", x)"], ["format!(\"{}\", x)", "Text from a format"], ["vec![items]", "A vector"], ["panic!(\"message\")"], ["assert!(condition)"],
    ["assert_eq!(left, right)"], ["Some(value)"], "None", ["Ok(value)"], ["Err(error)"], "Option", "Result", "String", "Vec", "HashMap", "HashSet", "BTreeMap", "VecDeque", "BinaryHeap", "Box",
    "i32", "i64", "u32", "u64", "usize", "f64", "bool", "char", "str", "std",
  ],
  members: {
    String: [["new()"], ["from(s)"], ["with_capacity(n)"]],
    Vec: [["new()"], ["with_capacity(n)"], ["from(items)"]],
    HashMap: [["new()"]], HashSet: [["new()"]], BTreeMap: [["new()"]], VecDeque: [["new()"]], BinaryHeap: [["new()"]], Box: [["new(value)"]],
    std: ["io", "collections", "cmp", "fmt", "mem", "process"],
    io: [["stdin()"], ["stdout()"], "Read", "Write", "BufRead"],
    "std::io": [["stdin()"], ["stdout()"], "Read", "Write", "BufRead"],
    "std::collections": ["HashMap", "HashSet", "BTreeMap", "VecDeque", "BinaryHeap"],
    "std::cmp": [["max(a, b)"], ["min(a, b)"], "Ordering", "Reverse"],
    "std::mem": [["swap(a, b)"], ["replace(dest, value)"], ["take(dest)"]],
    i32: ["MAX", "MIN"], i64: ["MAX", "MIN"], u64: ["MAX", "MIN"], usize: ["MAX", "MIN"], f64: ["MAX", "INFINITY", "consts"],
  },
  methods: [
    ["len()"], ["is_empty()"], ["push(x)"], ["pop()"], ["iter()"], ["iter_mut()"], ["into_iter()"], ["map(|x| x)"], ["filter(|x| true)"], ["collect::<Vec<_>>()"], ["sum::<i64>()"], ["count()"], ["enumerate()"], ["rev()"],
    ["zip(other)"], ["max()"], ["min()"], ["sort()"], ["sort_unstable()"], ["sort_by(|a, b| a.cmp(b))"], ["sort_by_key(|x| x)"], ["dedup()"], ["contains(&x)"], ["insert(key, value)"], ["remove(index)"], ["get(index)"],
    ["get_mut(index)"], ["unwrap()"], ["expect(\"message\")"], ["unwrap_or(default)"], ["clone()"], ["to_string()"], ["as_str()"], ["trim()"], ["split_whitespace()", "Words of a line"], ["split(pattern)"],
    ["parse::<i64>()", "Text to a number"], ["chars()"], ["bytes()"], ["lines()"], ["read_line(&mut line)", "Read a line into a String"], ["entry(key)"], ["or_insert(default)"], ["keys()"], ["values()"], ["join(separator)"],
    ["to_vec()"], ["extend(items)"], ["first()"], ["last()"], ["abs()"], ["pow(exp)"], ["sqrt()"], ["is_some()"], ["is_none()"], ["ok()"], ["and_then(|x| x)"], ["take(n)"], ["skip(n)"], ["fold(init, |acc, x| acc)"],
    ["any(|x| true)"], ["all(|x| true)"], ["position(|x| true)"], ["windows(size)"], ["chunks(size)"], ["swap(a, b)"], ["retain(|x| true)"], ["lock()"], ["flush()"], ["push_str(s)"], ["push_back(x)"], ["pop_front()"],
  ],
  access: ["::"],
};

const CSHARP: LanguageCompletions = {
  keywords: "abstract as base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit false finally float for foreach if implicit in int interface internal is lock long namespace new null object out override params private protected public readonly ref return sealed short static string struct switch this throw true try typeof uint ulong using var virtual void while async await record".split(" "),
  builtins: ["Console", "Math", "List", "Dictionary", "HashSet", "Queue", "Stack", "SortedDictionary", "LinkedList", "StringBuilder", "Array", "Convert", "Enumerable", "String", "Exception", "Random", "DateTime", "Tuple", "int", "long", "double", "string", "bool", "char"],
  members: {
    Console: [["WriteLine(value)", "Print, then a new line"], ["Write(value)"], ["ReadLine()", "Read a line (null at the end)"], ["Read()"], ["ReadKey()"]],
    Math: [["Abs(x)"], ["Max(a, b)"], ["Min(a, b)"], ["Pow(x, y)"], ["Sqrt(x)"], ["Floor(x)"], ["Ceiling(x)"], ["Round(x)"], ["Clamp(value, min, max)"], ["Log(x)"], "PI", "E"],
    int: [["Parse(s)", "Text to int"], ["TryParse(s, out var n)"], "MaxValue", "MinValue"], long: [["Parse(s)"], "MaxValue", "MinValue"], double: [["Parse(s)"], "MaxValue", "MinValue"],
    string: [["Join(separator, values)"], ["IsNullOrEmpty(s)"], ["IsNullOrWhiteSpace(s)"], ["Format(format, args)"], ["Concat(values)"], "Empty"],
    String: [["Join(separator, values)"], ["IsNullOrEmpty(s)"], ["Format(format, args)"]],
    Array: [["Sort(array)"], ["Reverse(array)"], ["IndexOf(array, value)"], ["Fill(array, value)"], ["Resize(ref array, size)"], ["Exists(array, match)"]],
    Convert: [["ToInt32(value)"], ["ToInt64(value)"], ["ToDouble(value)"], ["ToString(value)"], ["ToBoolean(value)"]],
    Enumerable: [["Range(start, count)"], ["Repeat(element, count)"], ["Empty<T>()"]],
  },
  methods: [
    ["Add(item)"], ["Remove(item)"], ["RemoveAt(index)"], ["Contains(item)"], "Count", "Length", ["Clear()"], ["Insert(index, item)"], ["IndexOf(item)"], ["Sort()"], ["Reverse()"], ["ToArray()"], ["ToList()"],
    ["Select(x => x)", "Transform each"], ["Where(x => true)", "Keep the ones that pass"], ["OrderBy(x => x)"], ["OrderByDescending(x => x)"], ["Sum()"], ["Max()"], ["Min()"], ["Average()"], ["First()"], ["Last()"],
    ["FirstOrDefault()"], ["Any()"], ["All(x => true)"], ["Count()"], ["Distinct()"], ["GroupBy(x => x)"], ["Take(n)"], ["Skip(n)"], ["Split(' ')"], ["Trim()"], ["ToUpper()"], ["ToLower()"], ["Substring(start, length)"],
    ["Replace(oldValue, newValue)"], ["StartsWith(value)"], ["EndsWith(value)"], ["ContainsKey(key)"], ["TryGetValue(key, out var value)"], "Keys", "Values", ["Enqueue(item)"], ["Dequeue()"], ["Push(item)"], ["Pop()"], ["Peek()"],
    ["Append(value)"], ["AppendLine(value)"], ["ToString()"], ["Equals(other)"], ["CompareTo(other)"], ["ToCharArray()"],
  ],
};

const PHP: LanguageCompletions = {
  keywords: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield true false null".split(" "),
  builtins: [
    ["echo"], ["print_r($value)"], ["var_dump($value)"], ["count($array)"], ["strlen($string)"], ["str_repeat($string, $times)"], ["explode($separator, $string)", "Split text into an array"], ["implode($separator, $array)", "Join an array"],
    ["array_push($array, $value)"], ["array_pop($array)"], ["array_shift($array)"], ["array_unshift($array, $value)"], ["array_map($callback, $array)"], ["array_filter($array, $callback)"], ["array_sum($array)"],
    ["array_keys($array)"], ["array_values($array)"], ["array_reverse($array)"], ["array_slice($array, $offset, $length)"], ["array_merge($a, $b)"], ["array_search($needle, $array)"], ["array_unique($array)"],
    ["in_array($needle, $array)"], ["sort($array)"], ["rsort($array)"], ["usort($array, $callback)"], ["ksort($array)"], ["max($values)"], ["min($values)"], ["abs($number)"], ["intval($value)"], ["floatval($value)"], ["strval($value)"],
    ["str_replace($search, $replace, $subject)"], ["strtolower($string)"], ["strtoupper($string)"], ["ucfirst($string)"], ["trim($string)"], ["substr($string, $start, $length)"], ["strpos($haystack, $needle)"],
    ["str_contains($haystack, $needle)"], ["sprintf($format, $values)"], ["printf($format, $values)"], ["json_encode($value)"], ["json_decode($json, true)"], ["fgets(STDIN)", "Read a line"], ["trim(fgets(STDIN))"],
    ["range($start, $end)"], ["isset($var)"], ["empty($var)"], ["unset($var)"], ["sqrt($number)"], ["pow($base, $exp)"], ["floor($number)"], ["ceil($number)"], ["round($number)"], ["rand($min, $max)"], ["number_format($number, $decimals)"],
    "PHP_EOL", "PHP_INT_MAX", "PHP_INT_MIN", "STDIN",
  ],
  members: {},
  methods: [],
  access: ["->", "::"],
};

const RUBY: LanguageCompletions = {
  keywords: "alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield".split(" "),
  builtins: [
    ["puts(value)", "Print, then a new line"], ["print(value)"], ["p(value)", "Print as inspected"], ["gets", "Read a line"], ["gets.chomp", "A line without its newline"], ["gets.to_i", "Read a whole number"], ["require 'set'"],
    ["attr_accessor :name"], ["attr_reader :name"], ["Array.new(size, value)"], ["Hash.new(0)", "A hash that starts counts at 0"], ["rand(max)"], ["loop do"], ["Integer(text)"], ["Float(text)"], ["format(format, values)"], ["sleep(seconds)"],
    "Array", "Hash", "String", "Integer", "Float", "Set", "Struct", "Math", "Comparable", "Enumerable", "StandardError", "ArgumentError",
  ],
  members: {
    Math: [["sqrt(x)"], ["cbrt(x)"], ["log(x)"], ["log2(x)"], ["log10(x)"], ["hypot(x, y)"], ["sin(x)"], ["cos(x)"], "PI", "E"],
    Integer: [["sqrt(n)", "Whole-number square root"]],
  },
  methods: [
    ["each { |x| }"], ["each_with_index { |x, i| }"], ["map { |x| }"], ["select { |x| }"], ["reject { |x| }"], ["reduce(:+)"], ["inject(:+)"], ["sum"], ["min"], ["max"], ["min_by { |x| }"], ["max_by { |x| }"], ["sort"], ["sort_by { |x| }"],
    ["reverse"], ["length"], ["size"], ["count"], ["include?(x)"], ["push(x)"], ["pop"], ["shift"], ["unshift(x)"], ["first"], ["last"], ["join(separator)"], ["split(separator)"], ["strip"], ["chomp"], ["chars"],
    ["to_i"], ["to_s"], ["to_f"], ["to_a"], ["to_sym"], ["upcase"], ["downcase"], ["capitalize"], ["keys"], ["values"], ["each_pair { |k, v| }"], ["times { |i| }"], ["upto(limit) { |i| }"], ["downto(limit) { |i| }"],
    ["step(limit, step) { |i| }"], ["uniq"], ["flatten"], ["zip(other)"], ["group_by { |x| }"], ["tally"], ["empty?"], ["nil?"], ["any? { |x| }"], ["all? { |x| }"], ["find { |x| }"], ["partition { |x| }"], ["each_slice(n)"],
    ["each_cons(n)"], ["gsub(pattern, replacement)"], ["sub(pattern, replacement)"], ["start_with?(prefix)"], ["end_with?(suffix)"], ["index(x)"], ["slice(start, length)"], ["freeze"], ["dup"], ["key?(key)"], ["fetch(key, default)"],
  ],
};

const SHELL: LanguageCompletions = {
  keywords: "if then else elif fi for in do done while until case esac function select return local export readonly declare break continue time".split(" "),
  builtins: [
    ["echo", "Print a line"], ["printf", "Print with a format"], ["read", "Read a line into variables: read -r name"], ["cd"], ["pwd"], ["ls"], ["cat"], ["grep", "Lines that match"], ["sed", "Edit text"], ["awk", "Columns and text processing"],
    ["sort"], ["uniq"], ["wc", "Count lines, words"], ["head"], ["tail"], ["cut"], ["tr"], ["find"], ["xargs"], ["test"], ["expr"], ["let"], ["mkdir"], ["rm"], ["cp"], ["mv"], ["touch"], ["chmod"], ["sleep"], ["date"],
    ["seq", "A sequence of numbers"], ["basename"], ["dirname"], ["exit"], ["shift"], ["set"], ["unset"], ["source"], ["eval"], ["mapfile", "Read lines into an array"], ["readarray"], ["trap"], ["wait"], ["true"], ["false"],
    ["$#", "Number of arguments"], ["$@", "All arguments"], ["$?", "Exit status of the last command"], ["$1", "First argument"], ["$0", "The script's name"], ["$RANDOM", "A random number"], ["$HOME"], ["$PWD"], ["$IFS", "Field separator"],
  ],
  members: {},
  methods: [],
};

const SQL: LanguageCompletions = {
  keywords: "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD COLUMN RENAME TO PRIMARY KEY FOREIGN REFERENCES NOT NULL UNIQUE DEFAULT CHECK INDEX VIEW TRIGGER JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING AS DISTINCT UNION ALL INTERSECT EXCEPT AND OR IN BETWEEN LIKE GLOB IS EXISTS CASE WHEN THEN ELSE END WITH RECURSIVE ASC DESC INTEGER TEXT REAL BLOB NUMERIC BOOLEAN AUTOINCREMENT IF BEGIN COMMIT ROLLBACK TRANSACTION REPLACE OVER PARTITION".split(" "),
  builtins: [
    ["COUNT(*)", "Number of rows"], ["COUNT(column)", "Rows where column is not NULL"], ["SUM(column)"], ["AVG(column)"], ["MIN(column)"], ["MAX(column)"], ["ROUND(value, digits)"], ["LENGTH(text)"], ["UPPER(text)"], ["LOWER(text)"],
    ["SUBSTR(text, start, length)"], ["TRIM(text)"], ["REPLACE(text, from, to)"], ["INSTR(text, find)"], ["COALESCE(a, b)", "The first that is not NULL"], ["IFNULL(value, fallback)"], ["NULLIF(a, b)"], ["ABS(value)"],
    ["CAST(value AS INTEGER)"], ["GROUP_CONCAT(column, ', ')", "Values joined into one"], ["DATE('now')"], ["STRFTIME('%Y-%m-%d', value)"], ["RANDOM()"], ["ROW_NUMBER() OVER (ORDER BY column)"], ["RANK() OVER (ORDER BY column)"],
    ["DENSE_RANK() OVER (ORDER BY column)"], ["LAG(column) OVER (ORDER BY column)"], ["LEAD(column) OVER (ORDER BY column)"],
  ],
  members: {},
  methods: [],
};

export const COMPLETIONS: Record<string, LanguageCompletions> = {
  java: JAVA,
  python: PYTHON,
  cpp: CPP,
  c: C,
  kotlin: KOTLIN,
  go: GO,
  rust: RUST,
  csharp: CSHARP,
  php: PHP,
  ruby: RUBY,
  shell: SHELL,
  sql: SQL,
};
