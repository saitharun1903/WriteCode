/**
 * The program that runs a file of SQL (Python, with the SQLite that ships in
 * it). It runs the file's statements one at a time on a new, empty database
 * and prints:
 *
 * - the rows of every statement that returns some, as a table: the column
 *   names, a rule, one line per row with ` | ` between the cells, then
 *   `(N rows)`. Inside a cell a backslash, a `|` and a line break are written
 *   `\\`, `\|` and `\n`, so the table reads back exactly (see the web app's
 *   `parseSqlOutput`);
 * - a line starting with `-- ` for what the other statements did (`-- 3 rows
 *   inserted into students`).
 *
 * An error names the line its statement starts on (`main.sql:7: error: ...`)
 * and stops the run.
 *
 * SQL is taught mostly with MySQL, so what MySQL scripts commonly contain is
 * accepted where SQLite has the same thing under another name: AUTO_INCREMENT
 * columns, table options (ENGINE=...), UNSIGNED, ENUM(...), `#` comments,
 * CREATE DATABASE and USE, SHOW TABLES, DESCRIBE, TRUNCATE, INSERT IGNORE, and
 * functions such as NOW(), CONCAT(), IF() and YEAR(). Nothing else is rewritten.
 */
export const SQL_RUNNER = String.raw`import datetime, random, re, sqlite3, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
db = sqlite3.connect(":memory:")
db.isolation_level = None
db.execute("PRAGMA foreign_keys = ON")

# ---- functions MySQL has and SQLite names differently or lacks
def _date(v):
    try:
        return datetime.datetime.fromisoformat(str(v).strip().replace("/", "-"))
    except Exception:
        return None

def _part(name):
    def get(v):
        d = _date(v)
        return None if d is None else getattr(d, name)
    return get

def _datediff(a, b):
    x, y = _date(a), _date(b)
    return None if x is None or y is None else (x.date() - y.date()).days

_FORMATS = {"%i": "%M", "%s": "%S", "%h": "%I", "%W": "%A", "%M": "%B", "%e": "%d", "%c": "%m", "%D": "%d", "%T": "%H:%M:%S", "%r": "%I:%M:%S %p"}
def _date_format(v, fmt):
    d = _date(v)
    if d is None or fmt is None:
        return None
    return d.strftime(re.sub(r"%.", lambda m: _FORMATS.get(m.group(0), m.group(0)), str(fmt)))

def _text(v):
    return v if isinstance(v, str) else str(int(v)) if isinstance(v, float) and v == int(v) else str(v)

def _concat(*a):
    return None if any(x is None for x in a) else "".join(_text(x) for x in a)

def _concat_ws(sep, *a):
    return None if sep is None else _text(sep).join(_text(x) for x in a if x is not None)

def _truncate(x, d):
    if x is None or d is None:
        return None
    f = 10 ** int(d)
    return int(x * f) / f

def _str(fn):
    return lambda s, *a: None if s is None else fn(str(s), *a)

_now = lambda: datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
for name, n, fn in [
    ("now", 0, _now), ("sysdate", 0, _now), ("curdate", 0, lambda: datetime.date.today().isoformat()), ("curtime", 0, lambda: datetime.datetime.now().strftime("%H:%M:%S")),
    ("year", 1, _part("year")), ("month", 1, _part("month")), ("day", 1, _part("day")), ("dayofmonth", 1, _part("day")), ("hour", 1, _part("hour")), ("minute", 1, _part("minute")), ("second", 1, _part("second")),
    ("dayname", 1, lambda v: None if _date(v) is None else _date(v).strftime("%A")), ("monthname", 1, lambda v: None if _date(v) is None else _date(v).strftime("%B")),
    ("datediff", 2, _datediff), ("date_format", 2, _date_format),
    ("concat", -1, _concat), ("concat_ws", -1, _concat_ws),
    ("if", 3, lambda c, a, b: a if c else b), ("ucase", 1, _str(str.upper)), ("lcase", 1, _str(str.lower)),
    ("truncate", 2, _truncate), ("rand", 0, random.random), ("char_length", 1, _str(len)), ("reverse", 1, _str(lambda s: s[::-1])),
    ("repeat", 2, _str(lambda s, n: s * max(0, int(n or 0)))),
    ("lpad", 3, _str(lambda s, n, p: s.rjust(int(n), str(p or " ")[:1])[: int(n)])), ("rpad", 3, _str(lambda s, n, p: s.ljust(int(n), str(p or " ")[:1])[: int(n)])),
]:
    db.create_function(name, n, fn)
# Maths functions are part of SQLite only when it was built with them.
for probe, fn in [("pow(2, 3)", lambda x, y: None if x is None or y is None else x ** y), ("power(2, 3)", lambda x, y: None if x is None or y is None else x ** y), ("mod(5, 2)", lambda x, y: None if x is None or not y else x % y), ("sqrt(4)", lambda x: None if x is None or x < 0 else x ** 0.5), ("ceiling(1.5)", lambda x: None if x is None else -int(-x // 1)), ("ceil(1.5)", lambda x: None if x is None else -int(-x // 1)), ("floor(1.5)", lambda x: None if x is None else int(x // 1))]:
    try:
        db.execute("SELECT " + probe)
    except sqlite3.Error:
        db.create_function(probe.split("(")[0], probe.count(",") + 1, fn)

# ---- SQL as its pieces: strings, quoted names and comments are each one piece
PIECE = re.compile(r"""'(?:[^']|'')*'|"(?:[^"]|"")*"|\x60[^\x60]*\x60|--[^\n]*|\#[^\n]*|/\*.*?\*/|[A-Za-z_][A-Za-z_0-9$]*|\s+|.""", re.S)

def is_space(p):
    return p.isspace() or p.startswith("--") or p.startswith("#") or p.startswith("/*")

def solid(ps):
    """The pieces that say something: no spaces, no comments."""
    return [p for p in ps if not is_space(p)]

def name_of(p):
    return p[1:-1] if len(p) > 1 and p[0] in "\"'\x60" else p

def create_table(ps):
    """CREATE TABLE written for MySQL, as SQLite reads it."""
    if "(" not in ps:
        return ps
    start, depth, end = ps.index("("), 0, None
    for i in range(start, len(ps)):
        depth += (ps[i] == "(") - (ps[i] == ")")
        if depth == 0:
            end = i
            break
    if end is None:
        return ps
    # Options after the closing bracket (ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ...) mean nothing here.
    tail = ps[end + 1 :]
    if solid(tail) and solid(tail)[0].upper() in ("ENGINE", "DEFAULT", "CHARSET", "CHARACTER", "COLLATE", "AUTO_INCREMENT", "COMMENT", "ROW_FORMAT"):
        tail = [p for p in tail if p == ";"]
    items, cur, depth = [], [], 0
    for p in ps[start + 1 : end]:
        depth += (p == "(") - (p == ")")
        if p == "," and depth == 0:
            items.append(cur)
            cur = []
        else:
            cur.append(p)
    items.append(cur)
    auto, out = None, []
    for item in items:
        real = solid(item)
        upper = [p.upper() for p in real]
        if "AUTO_INCREMENT" in upper or (len(upper) > 1 and upper[1] == "SERIAL"):
            # An auto-incrementing column is SQLite's INTEGER PRIMARY KEY AUTOINCREMENT.
            auto = name_of(real[0]).lower()
            rest = real[2:]
            if rest and rest[0] == "(":
                rest = rest[rest.index(")") + 1 :]
            rest = [p for p in rest if p.upper() not in ("AUTO_INCREMENT", "UNSIGNED", "ZEROFILL", "PRIMARY", "KEY", "UNIQUE")]
            item = [" ", real[0], " INTEGER PRIMARY KEY AUTOINCREMENT"] + [" " + p for p in rest]
        else:
            item = [p for p in item if p.upper() not in ("UNSIGNED", "ZEROFILL")]
            names = [p.upper() for p in item]
            if "ENUM" in names:
                # ENUM('a', 'b') is text.
                i = names.index("ENUM")
                after = [k for k in range(i + 1, len(item)) if not is_space(item[k])]
                if after and item[after[0]] == "(" and ")" in item[after[0] :]:
                    item = item[:i] + ["TEXT"] + item[item.index(")", after[0]) + 1 :]
        out.append(item)
    if auto is not None:
        # The key is on the column now: a separate PRIMARY KEY (that column) would declare it twice.
        def names_auto(item):
            real = solid(item)
            return [p.upper() for p in real[:3]] == ["PRIMARY", "KEY", "("] and len(real) == 5 and name_of(real[3]).lower() == auto
        out = [item for item in out if not names_auto(item)]
    body = []
    for i, item in enumerate(out):
        body += ([","] if i else []) + item
    return ps[: start + 1] + body + [")"] + tail

def cell(v):
    if v is None:
        return "NULL"
    text = "x'" + v.hex() + "'" if isinstance(v, bytes) else str(v)
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\r\n", "\\n").replace("\n", "\\n")

def show(cur):
    cols = [cell(d[0]) for d in cur.description]
    rows = [[cell(v) for v in r] for r in cur.fetchall()]
    w = [max([len(c)] + [len(r[i]) for r in rows]) for i, c in enumerate(cols)]
    line = lambda cells: " | ".join(c.ljust(w[i]) for i, c in enumerate(cells)).rstrip()
    print(line(cols))
    print("-+-".join("-" * x for x in w))
    for r in rows:
        print(line(r))
    print("(%d row%s)\n" % (len(rows), "" if len(rows) == 1 else "s"))

pending = None  # rows inserted into one table by statements in a row are reported together

def flush_inserts():
    global pending
    if pending:
        print("-- " + count(pending[1], "inserted into " + pending[0]))
    pending = None

def note(text):
    flush_inserts()
    print("-- " + text)

def count(n, what):
    return "%d row%s %s" % (n, "" if n == 1 else "s", what)

def run(stmt, at):
    global pending
    ps = PIECE.findall(stmt)
    # MySQL's # comments are SQLite's --.
    ps = ["--" + p[1:] if p.startswith("#") else p for p in ps]
    real = [p for p in solid(ps) if p != ";"]
    w = [p.upper() for p in real]
    if not w:
        return
    try:
        # There is one database: making one and choosing it are accepted, and change nothing.
        if w[0] in ("CREATE", "DROP") and len(w) > 2 and w[1] in ("DATABASE", "SCHEMA"):
            return note("Database %s %s" % (name_of(real[-1]), "created" if w[0] == "CREATE" else "dropped"))
        if w[0] == "USE" and len(w) == 2:
            return note("Using database " + name_of(real[1]))
        if w[:2] == ["SHOW", "DATABASES"]:
            return note("One database is used here; every run starts with it empty")
        if w[:2] == ["SHOW", "TABLES"]:
            flush_inserts()
            return show(db.execute("SELECT name AS Tables FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))
        table = real[1] if w[0] in ("DESCRIBE", "DESC") and len(w) == 2 else real[3] if w[:3] == ["SHOW", "COLUMNS", "FROM"] and len(w) == 4 else None
        if table is not None:
            flush_inserts()
            table = name_of(table)
            if not db.execute("SELECT 1 FROM pragma_table_info(?)", (table,)).fetchone():
                raise sqlite3.OperationalError("no such table: " + table)
            return show(db.execute("SELECT name AS Field, type AS Type, CASE WHEN \"notnull\" OR pk THEN 'NO' ELSE 'YES' END AS \"Null\", CASE WHEN pk THEN 'PRI' ELSE '' END AS \"Key\", dflt_value AS \"Default\" FROM pragma_table_info(?)", (table,)))
        if w[0] == "TRUNCATE":
            ps, real = ["DELETE FROM ", real[-1]], ["DELETE", "FROM", real[-1]]
            w = [p.upper() for p in real]
        if w[:2] == ["INSERT", "IGNORE"]:
            i = [p.upper() for p in ps].index("IGNORE")
            ps = ps[:i] + ["OR IGNORE"] + ps[i + 1 :]
        if w[0] == "CREATE" and "TABLE" in w[:3]:
            ps = create_table(ps)
        before = db.total_changes
        cur = db.execute("".join(ps))
        if cur.description:
            flush_inserts()
            return show(cur)
        changed = db.total_changes - before
        after = lambda word: name_of(real[w.index(word) + 1]) if word in w and w.index(word) + 1 < len(real) else "the table"
        if w[0] in ("INSERT", "REPLACE"):
            t = after("INTO")
            if pending and pending[0] == t:
                pending[1] += changed
            else:
                flush_inserts()
                pending = [t, changed]
        elif w[0] == "UPDATE":
            note(count(changed, "updated in " + name_of(real[1])))
        elif w[0] == "DELETE":
            note(count(changed, "deleted from " + after("FROM")))
        elif w[0] in ("CREATE", "DROP", "ALTER") and any(k in w[:4] for k in ("TABLE", "VIEW", "INDEX", "TRIGGER")):
            kind = next(k for k in ("TABLE", "VIEW", "INDEX", "TRIGGER") if k in w[:4])
            i = w.index(kind) + 1
            while i < len(w) and w[i] in ("IF", "NOT", "EXISTS"):
                i += 1
            note("%s %s %s" % (kind.capitalize(), name_of(real[i]) if i < len(real) else "", {"CREATE": "created", "DROP": "dropped", "ALTER": "changed"}[w[0]]))
        else:
            flush_inserts()
    except sqlite3.Error as e:
        flush_inserts()
        sys.stdout.flush()
        print("%s:%d: error: %s" % (path, at, e), file=sys.stderr)
        sys.exit(1)

stmt, at, line = [], 1, 1
for p in PIECE.findall(src):
    if not solid(stmt) and not is_space(p):
        at = line
    stmt.append(p)
    line += p.count("\n")
    # A ";" ends a statement, except inside one that has statements of its own (a trigger).
    if p == ";" and sqlite3.complete_statement("".join("--" + x[1:] if x.startswith("#") else x for x in stmt)):
        run("".join(stmt), at)
        stmt = []
if solid(stmt):
    run("".join(stmt), at)
flush_inserts()
`;
