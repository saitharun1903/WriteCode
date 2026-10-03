"""Code Workspace C / C++ / Rust tracer.

Runs inside gdb in the sandbox (gdb -q -nx -batch -x cw_trace_gdb.py
config.json) and records every line the program runs: the call stack with
each frame's variables, and the objects they reach (arrays, structs and
classes, pointers, and the standard containers through the libstdc++
printers). Writes the trace as JSON, the same format as the Python, Java and
JavaScript tracers.

The program is gdb's child. It reads its stdin directly (the input file or
the interactive FIFO); its stdout and stderr pass through this script, which
counts what was printed before each step and copies it out unchanged, so the
run's output is exactly what a normal run prints.
"""

import glob
import itertools
import json
import os
import re
import sys
import time

import gdb

CONFIG = json.load(open(os.environ.get("CW_TRACE_CONFIG", "/tmp/cwviz/config.json"), encoding="utf-8"))
LIMITS = CONFIG["limits"]
ROOT = os.path.normpath(CONFIG["root"])
FILES = set(CONFIG["files"])
LANGUAGE = CONFIG.get("language", "cpp")
RUST = LANGUAGE == "rust"
NULL = {"c": "NULL", "rust": "None"}.get(LANGUAGE, "nullptr")
if RUST:
    # Rust's printers, names and values (cw_gdb_rust.py, written next to this file).
    sys.path.insert(0, os.path.dirname(os.path.abspath(CONFIG.get("rustModule", "/tmp/cwviz/cw_gdb_rust.py"))))
    import cw_gdb_rust as rust
OUT_FIFO = "/tmp/cw-trace-out"
ERR_FIFO = "/tmp/cw-trace-err"
# Leave time for the program to finish and the trace to be written.
BUDGET_S = 14.0

# The program's output goes to the run's real stdout/stderr; gdb's own messages go nowhere.
REAL_OUT = os.dup(1)
REAL_ERR = os.dup(2)
_null = os.open(os.devnull, os.O_WRONLY)
os.dup2(_null, 1)
os.dup2(_null, 2)


# ------------------------------------------------------------------ output


class Relay:
    """Copies the program's output out as it comes, counting characters printed so far."""

    def __init__(self):
        self.fds = []
        self.printed = 0
        self.text = []
        self.errors = []
        self.decoder = None

    def open(self):
        import codecs
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        for path, target in ((OUT_FIFO, REAL_OUT), (ERR_FIFO, REAL_ERR)):
            # Read-write so opening never blocks and the pipe stays open between writes.
            fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
            self.fds.append((fd, target, target == REAL_OUT))

    def drain(self):
        for fd, target, counted in self.fds:
            while True:
                try:
                    data = os.read(fd, 65536)
                except BlockingIOError:
                    break
                except OSError:
                    break
                if not data:
                    break
                os.write(target, data)
                if counted:
                    text = self.decoder.decode(data)
                    self.text.append(text)
                    self.printed += len(text)
                else:
                    self.errors.append(data.decode("utf-8", "replace"))


relay = Relay()


# ------------------------------------------------------------------ values

_DEFAULT_ARGS = re.compile(r",\s*std::(allocator|less|char_traits|hash|equal_to|default_delete|deque)<")


def _drop_default_args(s):
    while True:
        m = _DEFAULT_ARGS.search(s)
        if not m:
            return s
        depth = 0
        i = m.end() - 1
        while i < len(s):
            if s[i] == "<":
                depth += 1
            elif s[i] == ">":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        s = s[: m.start()] + s[i + 1:]


def type_name(t):
    if RUST:
        try:
            return rust.type_name(str(t))
        except gdb.error:
            return "?"
    return c_type_name(t)


def c_type_name(t):
    """`vector<int>`, `map<string, int>`, `Node`, `int[4]`: short and as written."""
    try:
        s = str(t.unqualified() if hasattr(t, "unqualified") else t)
    except gdb.error:
        return "?"
    s = s.replace("std::__cxx11::", "std::")
    s = re.sub(r"std::basic_string<char(, std::char_traits<char>)?(, std::allocator<char>)?\s*>", "string", s)
    s = _drop_default_args(s)
    s = s.replace("std::basic_string<char>", "string").replace("std::", "")
    s = re.sub(r"^priority_queue<(.+?), vector<\1>", r"priority_queue<\1", s)
    s = re.sub(r"^(struct|class|union|enum) ", "", s)
    s = re.sub(r"\s*\[", "[", s)
    return re.sub(r"\s+>", ">", s).strip()


SCALAR_TYPE = {
    "_Bool": "bool",
}


def scalar_type(t):
    s = type_name(t)
    return SCALAR_TYPE.get(s, s)


def is_char(t):
    t = t.strip_typedefs()
    return t.code == gdb.TYPE_CODE_INT and t.sizeof == 1 and "char" in str(t)


def printer_of(v):
    try:
        return gdb.default_visualizer(v)
    except Exception:  # noqa: BLE001
        return None


def hint_of(p):
    try:
        return p.display_hint() if hasattr(p, "display_hint") else None
    except Exception:  # noqa: BLE001
        return None


def printer_text(p):
    try:
        s = p.to_string()
    except Exception:  # noqa: BLE001
        return None
    if isinstance(s, gdb.Value):
        try:
            return s.format_string()
        except gdb.error:
            return None
    return None if s is None else str(s)


def printer_children(p, limit):
    try:
        kids = p.children() if hasattr(p, "children") else None
        return [] if kids is None else list(itertools.islice(kids, limit))
    except Exception:  # noqa: BLE001
        return []


def total_of(p, got):
    m = re.search(r"(?:length|with) (\d+)", printer_text(p) or "")
    return int(m.group(1)) if m else got


def clip_str(s):
    n = LIMITS["maxStringChars"]
    return s if len(s) <= n else s[:n] + "…"


def scalar(v):
    """A value that is not an object: numbers, chars, bools, enums, strings."""
    t = v.type.strip_typedefs()
    try:
        if t.code == gdb.TYPE_CODE_BOOL:
            return {"kind": "value", "text": "true" if bool(v) else "false", "type": "bool"}
        if RUST and rust.is_char(t):
            return {"kind": "value", "text": rust.char_text(v), "type": "char"}
        if is_char(t):
            n = int(v)
            text = f"'{chr(n)}'" if 32 <= n < 127 and n not in (39, 92) else {0: "'\\0'", 10: "'\\n'", 9: "'\\t'", 39: "'\\''", 92: "'\\\\'"}.get(n, str(n))
            return {"kind": "value", "text": text, "type": "char"}
        if t.code == gdb.TYPE_CODE_ENUM:
            return {"kind": "value", "text": v.format_string().split("::")[-1], "type": type_name(v.type)}
        text = v.format_string(raw=True)
        return {"kind": "value", "text": text, "type": scalar_type(v.type)}
    except (gdb.error, gdb.MemoryError):
        return {"kind": "value", "text": "?", "type": scalar_type(v.type)}


def string_value(text):
    return {"kind": "value", "text": json.dumps(clip_str(text), ensure_ascii=False), "type": "string"}


class Snapshot:
    """Objects reachable from the frames at one step, by a stable id (address and type)."""

    def __init__(self):
        self.heap = {}
        self.count = 0

    def full(self):
        return self.count >= LIMITS["maxObjectsPerStep"]

    def obj_id(self, v, tname):
        try:
            addr = int(v.address) if v.address is not None else None
        except (gdb.error, gdb.MemoryError):
            addr = None
        return f"{addr:x}:{tname}" if addr is not None else None

    def value(self, v, depth=0):
        """The trace value for `v`: inline for scalars and strings, a reference for objects."""
        if not isinstance(v, gdb.Value):
            # Some printers yield plain Python values (vector<bool> yields bools).
            if isinstance(v, bool):
                return {"kind": "value", "text": "true" if v else "false", "type": "bool"}
            if isinstance(v, (int, float)):
                return {"kind": "value", "text": str(v), "type": "int" if isinstance(v, int) else "double"}
            return string_value(str(v))
        try:
            t0 = v.type.strip_typedefs()
            if t0.code in (gdb.TYPE_CODE_REF, getattr(gdb, "TYPE_CODE_RVALUE_REF", -1)):
                v = v.referenced_value()
            t = v.type.strip_typedefs()
            p = printer_of(v)
            if p is not None:
                hint = hint_of(p)
                if hint == "string" or not hasattr(p, "children"):
                    text = printer_text(p)
                    if text is not None and len(text) >= 2 and text[0] == '"' and text[-1] == '"':
                        return {"kind": "value", "text": clip_str(text), "type": "string"}
                    return {"kind": "value", "text": text if text is not None else "?", "type": type_name(v.type)}
                return self.container(v, p, hint, depth)
            if RUST:
                shown = self.rust_value(v, t, depth)
                if shown is not None:
                    return shown
            if t.code == gdb.TYPE_CODE_PTR:
                if int(v) == 0:
                    return {"kind": "value", "text": NULL, "type": type_name(v.type)}
                target = t.target().strip_typedefs()
                if is_char(target):
                    try:
                        return string_value(v.string(errors="replace"))
                    except (gdb.error, gdb.MemoryError, UnicodeError):
                        return {"kind": "value", "text": hex(int(v)), "type": type_name(v.type)}
                if target.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION) or printer_of(v.dereference()) is not None:
                    try:
                        return self.value(v.dereference(), depth + 1)
                    except (gdb.error, gdb.MemoryError):
                        return {"kind": "value", "text": hex(int(v)), "type": type_name(v.type)}
                if target.code == gdb.TYPE_CODE_FUNC:
                    return {"kind": "value", "text": hex(int(v)), "type": type_name(v.type)}
                try:
                    inner = scalar(v.dereference())
                    return {"kind": "value", "text": f"→ {inner['text']}", "type": type_name(v.type)}
                except (gdb.error, gdb.MemoryError):
                    return {"kind": "value", "text": hex(int(v)), "type": type_name(v.type)}
            if t.code == gdb.TYPE_CODE_ARRAY:
                if is_char(t.target()):
                    try:
                        return string_value(v.string(errors="replace"))
                    except (gdb.error, gdb.MemoryError, UnicodeError):
                        pass
                return self.array(v, t, depth)
            if t.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                return self.struct(v, t, depth)
            return scalar(v)
        except (gdb.error, gdb.MemoryError, RuntimeError):
            return {"kind": "value", "text": "?", "type": "?"}

    def rust_value(self, v, t, depth):
        """Rust values gdb has no printer for: Option (its value, or None), enums, tuples, references to numbers."""
        if rust.is_enum(t):
            name, inner = rust.variant(v)
            fields = rust.variant_fields(inner) if inner is not None else []
            if rust.is_option(t):
                if name == "Some" and fields:
                    return self.value(fields[0][1], depth + 1)
                return {"kind": "value", "text": "None", "type": type_name(v.type)}
            enum = re.sub(r"<.*$", "", type_name(v.type))
            label = f"{enum}::{name}" if name else enum
            if not fields:
                return {"kind": "value", "text": label, "type": type_name(v.type)}
            oid = self.obj_id(v, label) or f"e{id(v)}:{label}"
            return self._register(oid, lambda: {"kind": "object", "type": label, "fields": [[n, self.value(x, depth + 1)] for n, x in fields]}) or {"kind": "value", "text": label, "type": label}
        if rust.is_tuple(t):
            tname = type_name(v.type)
            oid = self.obj_id(v, tname) or f"t{id(v)}:{tname}"
            return self._register(oid, lambda: {"kind": "sequence", "type": tname, "items": [self.value(x, depth + 1) for _, x in rust.variant_fields(v)]}) or {"kind": "value", "text": "(…)", "type": tname}
        if t.code == gdb.TYPE_CODE_PTR and int(v) != 0 and rust.scalar_target(t):
            return {"kind": "value", "text": scalar(v.dereference())["text"], "type": type_name(v.type)}
        return None

    def _register(self, oid, make):
        if oid in self.heap:
            return {"kind": "ref", "id": oid}
        if self.full():
            return None
        self.count += 1
        self.heap[oid] = {"kind": "other", "type": "", "text": "…"}  # placeholder against cycles
        self.heap[oid] = make()
        return {"kind": "ref", "id": oid}

    def container(self, v, p, hint, depth):
        tname = type_name(v.type)
        oid = self.obj_id(v, tname) or f"c{id(v)}:{tname}"
        limit = LIMITS["maxItemsPerObject"]

        def make():
            if hint == "map":
                kids = printer_children(p, limit * 2 + 2)
                pairs = [(kids[i][1], kids[i + 1][1]) for i in range(0, min(len(kids), limit * 2) - 1, 2)]
                entries = [[self.value(k, depth + 1), self.value(x, depth + 1)] for k, x in pairs]
                total = total_of(p, len(kids) // 2)
                o = {"kind": "map", "type": tname, "entries": entries}
                if total > len(entries):
                    o["omitted"] = total - len(entries)
                return o
            kids = printer_children(p, limit + 1)
            items = [self.value(x, depth + 1) for _, x in kids[:limit]]
            total = total_of(p, len(kids))
            o = {"kind": "sequence", "type": tname, "items": items}
            if total > len(items):
                o["omitted"] = total - len(items)
            return o

        return self._register(oid, make) or {"kind": "value", "text": "{…}", "type": tname}

    def array(self, v, t, depth):
        tname = type_name(v.type)
        oid = self.obj_id(v, tname) or f"a{id(v)}:{tname}"
        try:
            lo, hi = t.range()
            n = max(0, hi - lo + 1)
        except (gdb.error, RuntimeError):
            n = 0
        limit = LIMITS["maxItemsPerObject"]

        def make():
            items = [self.value(v[i], depth + 1) for i in range(min(n, limit))]
            o = {"kind": "sequence", "type": re.sub(r"\[\d*\]$", "[]", tname) if tname.count("[") == 1 else tname, "items": items}
            if n > len(items):
                o["omitted"] = n - len(items)
            return o

        return self._register(oid, make) or {"kind": "value", "text": "[…]", "type": tname}

    def struct(self, v, t, depth):
        tname = type_name(v.type)
        oid = self.obj_id(v, tname) or f"s{id(v)}:{tname}"

        def make():
            fields = []
            for f in t.fields():
                if f.is_base_class:
                    try:
                        base = self.struct(v[f], f.type.strip_typedefs(), depth + 1)
                    except gdb.error:
                        continue
                    if base:
                        fields.append([type_name(f.type), base])
                    continue
                if not f.name or getattr(f, "artificial", False) or f.name.startswith("_vptr") or not hasattr(f, "bitpos"):
                    continue
                try:
                    fields.append([f.name, self.value(v[f], depth + 1)])
                except gdb.error:
                    continue
            limit = LIMITS["maxItemsPerObject"]
            o = {"kind": "object", "type": tname, "fields": fields[:limit]}
            if len(fields) > limit:
                o["omitted"] = len(fields) - limit
            return o

        return self._register(oid, make) or {"kind": "value", "text": "{…}", "type": tname}


# ------------------------------------------------------------------ frames


def project_file(frame):
    try:
        sal = frame.find_sal()
        if sal.symtab is None:
            return None
        full = os.path.normpath(sal.symtab.fullname())
    except (gdb.error, RuntimeError):
        return None
    if not full.startswith(ROOT + "/"):
        return None
    rel = full[len(ROOT) + 1:]
    return rel if rel in FILES else None


def frame_name(f):
    try:
        fn = f.function()
        name = fn.print_name if fn is not None else (f.name() or "??")
    except (gdb.error, RuntimeError):
        name = f.name() or "??"
    if RUST:
        return rust.frame_name(name, f)
    depth = 0
    for i, ch in enumerate(name):
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth -= 1
        elif ch == "(" and depth == 0:
            name = name[:i]
            break
    return name.replace("::", ".")


def frame_symbols(frame):
    """(name, gdb.Value) of the arguments, then the locals declared before the current line."""
    try:
        block = frame.block()
        line = frame.find_sal().line
    except (gdb.error, RuntimeError):
        return []
    blocks = []
    while block is not None:
        blocks.append(block)
        if block.function is not None:
            break
        block = block.superblock
    args, local = [], []
    seen = set()
    for b in reversed(blocks):
        for sym in b:
            if not (sym.is_variable or sym.is_argument) or sym.name in seen or sym.name.startswith("__"):
                continue
            if RUST and rust.hidden(sym):
                continue
            if sym.is_variable and not sym.is_argument and sym.line >= line:
                continue
            if sym.addr_class == gdb.SYMBOL_LOC_STATIC:
                continue
            try:
                value = sym.value(frame)
            except (gdb.error, RuntimeError):
                continue
            seen.add(sym.name)
            (args if sym.is_argument else local).append((sym.name, value))
    return args + local


_globals = None


def global_symbols():
    """Variables defined at file level in the project's own files, in the order written."""
    global _globals
    if _globals is not None:
        return _globals
    out = []
    try:
        listing = gdb.execute("info variables -n", to_string=True)
    except gdb.error:
        listing = ""
    file = None
    found = []
    for line in listing.split("\n"):
        m = re.match(r"File (.+):$", line.strip())
        if m:
            path = os.path.normpath(os.path.join(ROOT, m.group(1)))
            file = path[len(ROOT) + 1:] if path.startswith(ROOT + "/") else None
            file = file if file in FILES else None
            continue
        m = re.match(r"(\d+):\s+(.*);$", line.strip())
        if not m or file is None:
            continue
        decl = re.sub(r"\[[^\]]*\]", "", m.group(2)).strip()
        name = re.search(r"([A-Za-z_]\w*)\s*$", decl)
        if name and "(" not in decl:
            found.append((file, int(m.group(1)), name.group(1)))
    for _, _, name in sorted(found):
        try:
            sym = gdb.lookup_static_symbol(name) or gdb.lookup_global_symbol(name)
        except (gdb.error, AttributeError):
            sym = None
        if sym is not None and sym.is_variable:
            out.append(sym)
    _globals = out
    return out


def snapshot(event, exception=None, return_value=None):
    snap = Snapshot()
    frames = []
    f = gdb.newest_frame()
    stack = []
    while f is not None and len(stack) < 200:
        if project_file(f):
            stack.append(f)
        try:
            f = f.older()
        except gdb.error:
            break
    if not stack:
        return None
    stack.reverse()
    globs = global_symbols()
    if globs:
        locals_ = []
        for sym in globs:
            try:
                locals_.append([sym.name, snap.value(sym.value())])
            except (gdb.error, RuntimeError):
                continue
        frames.append({"name": "<module>", "file": project_file(stack[0]), "line": 0, "locals": locals_})
    for f in stack:
        locals_ = [[n, snap.value(v)] for n, v in frame_symbols(f)]
        frames.append({"name": frame_name(f), "file": project_file(f), "line": f.find_sal().line, "locals": locals_})
    if return_value is not None:
        frames[-1]["returnValue"] = return_value if isinstance(return_value, dict) else snap.value(return_value)
    relay.drain()
    step = {"event": event, "frames": frames, "heap": snap.heap, "stdoutLength": relay.printed}
    if exception:
        step["exception"] = exception
    return step


# ------------------------------------------------------------------ running

steps = []
truncated = None
last_stop = [None]
exit_code = [None]


def on_stop(ev):
    last_stop[0] = ev


def on_exit(ev):
    exit_code[0] = getattr(ev, "exit_code", None)


def alive():
    try:
        inf = gdb.selected_inferior()
        return inf.pid != 0
    except (gdb.error, RuntimeError):
        return False


def run(command):
    last_stop[0] = None
    try:
        return gdb.execute(command, to_string=True) or ""
    except gdb.error as e:
        return str(e)


SIGNALS = {
    "SIGSEGV": "Segmentation fault: memory the program does not own was read or written (a null or dangling pointer, or an index out of range)",
    "SIGFPE": "Arithmetic error (SIGFPE), such as a division by zero",
    "SIGABRT": "The program aborted (SIGABRT): an assert failed or an exception was not caught",
    "SIGBUS": "Bus error (SIGBUS): a bad memory access",
}

CALL = re.compile(r"[A-Za-z_]\w*\s*(<[^;]*>)?\s*\(")
KEYWORDS_BEFORE_PAREN = {"return", "if", "while", "for", "switch", "sizeof", "catch"}


def source_line(frame):
    try:
        sal = frame.find_sal()
        with open(sal.symtab.fullname(), encoding="utf-8", errors="replace") as fh:
            return fh.read().split("\n")[sal.line - 1]
    except (OSError, IndexError, AttributeError, gdb.error, RuntimeError):
        return ""


def returns_without_calls(frame):
    """A `return x;` line, or the closing brace: finishing it runs none of the program's code."""
    code = re.sub(r"//.*$|\"(\\.|[^\"])*\"|'(\\.|[^'])*'", "", source_line(frame)).strip()
    if code == "}":
        return True
    if not re.match(r"return\b", code):
        return False
    return not any(m.group(0).split("(")[0].split("<")[0].strip() not in KEYWORDS_BEFORE_PAREN for m in CALL.finditer(code))


def panic_message():
    """`attempt to subtract with overflow`, from what the panic printed (`thread 'main' panicked at main.rs:4:5:`, then the message)."""
    for _ in range(20):
        relay.drain()
        text = "".join(relay.errors)
        m = re.search(r"panicked at [^\n]*:\n(.*)", text)
        if m:
            return f"panic: {m.group(1).strip()}"
        time.sleep(0.02)
    return "panic"


held = [None]


def record(step, brace=False):
    """Adds a step. A stop on a lone `}` waits for the next stop, which decides whether it was real."""
    if step is None:
        return
    pending = held[0]
    held[0] = None
    if pending is not None:
        last, key = pending
        cur = step["frames"][-1]
        same_call = len(step["frames"]) == len(last["frames"]) and cur["name"] == last["frames"][-1]["name"]
        if brace and same_call and cur["line"] == last["frames"][-1]["line"]:
            # The same brace again, after destructors ran: the first stop shows the values as they were.
            held[0] = pending
            return
        # Execution went back up in the same call (the brace was cleanup code, not the end of the
        # block), or stopped on the same brace again: the held stop was not a step of its own.
        if not (same_call and cur["line"] <= last["frames"][-1]["line"]):
            _append(last)
    if brace:
        held[0] = (step, None)
        return
    _append(step)


def _append(step):
    if steps and json.dumps(steps[-1], sort_keys=True) == json.dumps(step, sort_keys=True):
        return
    steps.append(step)


def flush():
    if held[0] is not None:
        _append(held[0][0])
        held[0] = None


def main():
    global truncated
    for cmd in (
        "set confirm off",
        "set pagination off",
        "set width 0",
        "set breakpoint pending off",
        "set disable-randomization off",
        "set startup-with-shell on",
        "set print object on",
        "skip -gfi /usr/**",
    ):
        try:
            gdb.execute(cmd, to_string=True)
        except gdb.error:
            pass
    for path in [] if RUST else sorted(glob.glob("/usr/local/share/gcc-*/python")) + ["/usr/share/gcc/python"]:
        if os.path.isdir(os.path.join(path, "libstdcxx")):
            sys.path.insert(0, path)
            try:
                from libstdcxx.v6.printers import register_libstdcxx_printers
                register_libstdcxx_printers(None)
            except Exception:  # noqa: BLE001
                pass
            break
    os.chdir(ROOT)
    gdb.execute(f"file {CONFIG.get('program', 'out/main')}", to_string=True)
    panic = None
    if RUST:
        rust.setup()
        try:
            panic = gdb.Breakpoint(rust.PANIC_SYMBOL, internal=True)
        except gdb.error:
            panic = None
    gdb.events.stop.connect(on_stop)
    gdb.events.exited.connect(on_exit)
    for path in (OUT_FIFO, ERR_FIFO):
        if not os.path.exists(path):
            os.mkfifo(path)
    relay.open()
    stdin = CONFIG.get("stdin")
    stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
    gdb.execute("set exec-wrapper stdbuf -o0 -e0", to_string=True)
    # Stop at the first line of main, then step through every line of the program's own files.
    try:
        start = gdb.Breakpoint(CONFIG.get("start", "main"), internal=True)
    except gdb.error:
        start = None
    run(f"run < {stdin} > {OUT_FIFO} 2> {ERR_FIFO}")
    if start is not None and start.is_valid():
        start.delete()
    started = time.monotonic()
    tracing = True
    while alive():
        ev = last_stop[0]
        if panic is not None and isinstance(ev, gdb.BreakpointEvent) and panic in ev.breakpoints:
            # A panic: its message is printed; the step is where the program's own code panicked.
            if tracing:
                flush()
                record(snapshot("exception", exception=panic_message()))
            tracing = False
            run("continue")
            continue
        if isinstance(ev, gdb.SignalEvent) and ev.stop_signal in SIGNALS:
            if tracing:
                flush()
                record(snapshot("exception", exception=SIGNALS[ev.stop_signal]))
            tracing = False
            run("continue")
            continue
        if not tracing:
            run("continue")
            continue
        top = gdb.newest_frame()
        if project_file(top) is None:
            # In a library, or past the end of main: back to the program, or run to the end.
            stack_has_project = False
            f = top
            while f is not None:
                if project_file(f):
                    stack_has_project = True
                    break
                try:
                    f = f.older()
                except gdb.error:
                    break
            run("finish" if stack_has_project else "continue")
            continue
        record(snapshot("line"), brace=source_line(top).strip() == "}")
        if len(steps) >= LIMITS["maxSteps"]:
            truncated = f"Recording stopped after {LIMITS['maxSteps']} steps; the program continued without recording."
            tracing = False
            continue
        if time.monotonic() - started > BUDGET_S:
            truncated = "Recording stopped because the program ran for a long time; it continued without recording."
            tracing = False
            continue
        if returns_without_calls(top) and frame_name(top) != "main":
            # The function returns on this line: finish it to show what it returns.
            flush()
            before = gdb.history_count()
            run("finish")
            if alive() and gdb.history_count() > before:
                try:
                    returned = gdb.history(0)
                    caller = gdb.newest_frame()
                    # The step where the call returns: the callee is still on the stack in the trace.
                    step = steps[-1] if steps else None
                    if step is not None:
                        snap = Snapshot()
                        rv = snap.value(returned)
                        ret = json.loads(json.dumps(step))
                        ret["event"] = "return"
                        ret["frames"][-1]["returnValue"] = rv
                        ret["heap"].update({k: v for k, v in snap.heap.items() if k not in ret["heap"]})
                        relay.drain()
                        ret["stdoutLength"] = relay.printed
                        steps.append(ret)
                    del caller
                except (gdb.error, RuntimeError, IndexError):
                    pass
            continue
        run("step")
    flush()
    relay.drain()
    write_trace()


def write_trace():
    trace = {"language": LANGUAGE, "steps": steps, "stdout": "".join(relay.text)}
    if truncated:
        trace["truncated"] = truncated
    text = json.dumps(trace, ensure_ascii=False)
    while len(text) > LIMITS["maxTraceBytes"] and len(trace["steps"]) > 1:
        trace["steps"] = trace["steps"][: int(len(trace["steps"]) * 0.8)]
        trace["truncated"] = "The recording was too large; the last steps were dropped."
        text = json.dumps(trace, ensure_ascii=False)
    with open(CONFIG["out"], "w", encoding="utf-8") as fh:
        fh.write(text)


try:
    main()
except Exception as e:  # noqa: BLE001 - never leave the run without a trace or an explanation
    truncated = f"Recording stopped: {type(e).__name__}: {e}"
    try:
        flush()
        # The program still finishes, untraced, with all of its output.
        while alive():
            run("continue")
            relay.drain()
        relay.drain()
        write_trace()
    except Exception:  # noqa: BLE001
        pass
code = exit_code[0]
if code is None:
    try:
        sig = gdb.parse_and_eval("$_exitsignal")
        code = 128 + int(sig) if sig.type.code != gdb.TYPE_CODE_VOID else 0
    except gdb.error:
        code = 0
os._exit(int(code) & 0xFF)
