/**
 * The program that runs a file of SQL (Python, with the SQLite that ships in
 * it). It runs the file's statements one at a time and prints:
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
 * The database belongs to the project, as it does in a database tool: a run
 * starts from what the runs before it left. The sandbox keeps nothing, so the
 * database travels with the run. It comes in as the file `SQL_STATE_FILE`
 * (`{ data, names, current }`, `data` being the SQLite database deflated and in
 * base64), and goes out after the output: the character `SQL_STATE_MARK`, then
 * one line of JSON with the database as it is now (`data`), its tables and
 * views with their columns (`tables`), and what every statement did (`log`).
 * Without the file (a test case, an interview's hidden tests) the run starts
 * empty and prints nothing after its output.
 *
 * SQL is taught mostly with MySQL, so what MySQL scripts commonly contain is
 * accepted where SQLite has the same thing under another name: AUTO_INCREMENT
 * columns, table options (ENGINE=...), UNSIGNED, ENUM(...), `#` comments,
 * CREATE DATABASE and USE, SHOW DATABASES, SHOW TABLES, DESCRIBE, TRUNCATE,
 * INSERT IGNORE, and functions such as NOW(), CONCAT(), IF() and YEAR().
 * Nothing else is rewritten. There is one database: CREATE DATABASE and USE
 * name it, and DROP DATABASE of the one in use empties it.
 */
/** The file a run's database arrives in. */
export const SQL_STATE_FILE = "cw-database.json";
/** In a run's output, what follows this character is the database after the run, not something the program printed. */
export const SQL_STATE_MARK = "\x1e";

export const SQL_RUNNER = String.raw`import base64, datetime, json, os, random, re, sqlite3, sys, time, zlib

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
db = sqlite3.connect(":memory:")
db.isolation_level = None

# ---- the project's database: what the runs before this one left in it
STATE = "cw-database.json"
# Without the file (a test, a judge) the run starts empty and leaves nothing behind.
keeps = os.path.exists(STATE)
names, current = [], None
if keeps:
    try:
        saved = json.load(open(STATE, encoding="utf-8"))
        names = [str(n) for n in saved.get("names") or []][:50]
        current = saved.get("current") if saved.get("current") in names else None
        if saved.get("data"):
            db.deserialize(zlib.decompress(base64.b64decode(saved["data"])))
            db.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except Exception:
        db = sqlite3.connect(":memory:")
        db.isolation_level = None
        names, current = [], None
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
    ("database", 0, lambda: current or "main"), ("schema", 0, lambda: current or "main"), ("version", 0, lambda: "SQLite " + sqlite3.sqlite_version),
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
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\r\n", "\\n").replace("\n", "\\n").replace("\x1e", " ")

def show(cur):
    global last
    cols = [cell(d[0]) for d in cur.description]
    rows = [[cell(v) for v in r] for r in cur.fetchall()]
    last = count(len(rows), "returned")
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
    global last
    flush_inserts()
    print("-- " + text)
    last = text

# ---- what every statement did, for the list beside the results
log, last = [], None

def record(at, ps, message, ok, started):
    if len(log) < 400:
        text = " ".join("".join(p for p in ps if not (p.startswith("--") or p.startswith("/*"))).split())
        log.append({"line": at, "sql": text[:200], "message": message, "ok": ok, "ms": round((time.perf_counter() - started) * 1000, 2)})

def objects():
    """The tables and views of the database, with their columns."""
    out = []
    for name, kind in db.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name COLLATE NOCASE").fetchall()[:200]:
        cols, rows = [], None
        try:
            refs = {}
            if kind == "table":
                for r in db.execute("SELECT * FROM pragma_foreign_key_list(?)", (name,)):
                    refs[r[3]] = "%s.%s" % (r[2], r[4]) if r[4] else r[2]
            for c in db.execute('SELECT name, type, "notnull", pk FROM pragma_table_info(?)', (name,)):
                col = {"name": c[0], "type": c[1] or ""}
                if c[3]:
                    col["pk"] = True
                elif c[2]:
                    col["notNull"] = True
                if c[0] in refs:
                    col["ref"] = refs[c[0]]
                cols.append(col)
            if kind == "table":
                rows = db.execute('SELECT count(*) FROM "%s"' % name.replace('"', '""')).fetchone()[0]
        except sqlite3.Error:
            pass
        out.append({"name": name, "kind": kind, "columns": cols, "rows": rows})
    return out

def drop_all():
    db.execute("PRAGMA foreign_keys = OFF")
    for kind in ("view", "table"):
        for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'", (kind,)).fetchall():
            db.execute('DROP %s IF EXISTS "%s"' % (kind.upper(), name.replace('"', '""')))
    db.execute("PRAGMA foreign_keys = ON")

def finish(code):
    """Ends the run. After the output comes the database as it is now, for the next run to start from."""
    flush_inserts()
    if keeps:
        out = {"v": 1, "log": log}
        try:
            if db.in_transaction:
                db.execute("ROLLBACK")
                print("-- The transaction was not committed, so its changes were rolled back")
            out["tables"] = objects()
            data = ""
            if out["tables"]:
                try:
                    db.execute("VACUUM")
                except sqlite3.Error:
                    pass
                data = base64.b64encode(zlib.compress(db.serialize(), 6)).decode("ascii")
            if len(data) > 240000:
                out["tooLarge"] = True
            else:
                out["data"] = data
        except Exception as e:
            out["failed"] = str(e)
        out["names"], out["current"] = names, current
        sys.stdout.flush()
        sys.stdout.write("\x1e" + json.dumps(out) + "\n")
    sys.stdout.flush()
    sys.exit(code)

def hint(message):
    """One more line under an error, when the cause is likely something the run cannot show."""
    m = re.match(r"(table|view|index|trigger) (.+) already exists", message)
    if m and keeps:
        return "It is in the database from an earlier run: the database keeps what was made in it. Write DROP %s IF EXISTS %s; above this statement, or reset the database." % (m.group(1).upper(), m.group(2))
    if message.startswith("UNIQUE constraint failed") and keeps:
        return "A row with that value is already in the table. Rows stay in the database from one run to the next, until they are deleted or the database is reset."
    if message.startswith("no such table"):
        have = [t["name"] for t in objects() if t["kind"] == "table"]
        return "The tables in the database: %s." % ", ".join(have[:30]) if have else "The database has no tables yet. Run the CREATE TABLE statements first."
    return None

def count(n, what):
    return "%d row%s %s" % (n, "" if n == 1 else "s", what)

def run(stmt, at):
    global pending, last, current
    ps = PIECE.findall(stmt)
    # MySQL's # comments are SQLite's --.
    ps = ["--" + p[1:] if p.startswith("#") else p for p in ps]
    real = [p for p in solid(ps) if p != ";"]
    w = [p.upper() for p in real]
    if not w:
        return
    last, started = None, time.perf_counter()
    try:
        execute(ps, real, w)
        record(at, ps, last or "Done", True, started)
    except sqlite3.Error as e:
        flush_inserts()
        record(at, ps, str(e), False, started)
        sys.stdout.flush()
        print("%s:%d: error: %s" % (path, at, e), file=sys.stderr)
        more = hint(str(e))
        if more:
            print(more, file=sys.stderr)
        finish(1)

def execute(ps, real, w):
    global pending, last, current
    # There is one database. Making one names it, USE chooses the name, and dropping the one in use empties it.
    if w[0] in ("CREATE", "DROP") and len(w) > 2 and w[1] in ("DATABASE", "SCHEMA"):
        i = 2
        while i < len(w) - 1 and w[i] in ("IF", "NOT", "EXISTS"):
            i += 1
        name = name_of(real[i])
        if w[0] == "CREATE":
            if name in names:
                return note("Database %s is already there" % name)
            names.append(name)
            if current is None:
                current = name
            return note("Database %s created" % name)
        if name not in names:
            return note("There is no database %s" % name)
        names.remove(name)
        if name == current:
            drop_all()
            current = names[0] if names else None
        return note("Database %s dropped" % name)
    if w[0] == "USE" and len(w) == 2:
        current = name_of(real[1])
        if current not in names:
            names.append(current)
        return note("Using database " + current)
    if w[:2] in (["SHOW", "DATABASES"], ["SHOW", "SCHEMAS"]):
        flush_inserts()
        return show(db.execute("SELECT value AS \"Database\" FROM json_each(?)", (json.dumps(names or ["main"]),)))
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
    # DROP ... IF EXISTS of something that is not there does nothing, and says so.
    gone = None
    if w[0] == "DROP" and len(w) > 3 and w[1] in ("TABLE", "VIEW", "INDEX", "TRIGGER") and w[2:4] == ["IF", "EXISTS"] and len(real) > 4:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? COLLATE NOCASE", (w[1].lower(), name_of(real[4]))).fetchone():
            gone = "There was no %s %s to drop" % (w[1].lower(), name_of(real[4]))
    before = db.total_changes
    cur = db.execute("".join(ps))
    if gone:
        return note(gone)
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
        last = count(changed, "inserted into " + t)
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
finish(0)
`;
