"""Code Workspace C / C++ / Rust debug adapter.

Runs inside gdb in the sandbox (gdb -q -nx -batch -x cw_gdb_adapter.py) and
speaks newline-delimited JSON on gdb's stdin/stdout, the same protocol as the
Java, Python and JavaScript adapters:

  in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
       | setBreakpoints | variables | evaluate | terminate
  out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}

The program runs as gdb's child with its own stdin (the run's input file or
the interactive FIFO); its stdout and stderr go through FIFOs and are relayed
as "output" events, unbuffered so output appears as each line runs. Stepping
stays in the project's files. Values are read with the libstdc++ pretty
printers (vector, string, map...). Watch expressions cannot call functions
or write memory, so inspecting never changes the program.
"""

import glob
import itertools
import json
import os
import queue
import re
import signal
import sys
import threading
import time

import gdb

MAX_CHILDREN = 200
MAX_FRAMES = 200
PREVIEW_ITEMS = 8
PREVIEW_CHARS = 200
THREAD = "main"
OUT_FIFO = "/tmp/cw-out"
# How a null pointer reads in the program's language (C: NULL, C++: nullptr).
NULL = ["nullptr"]
# Rust's printers, names and values (cw_gdb_rust.py), loaded when the program is Rust.
rust = None
ERR_FIFO = "/tmp/cw-err"

proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
out_lock = threading.Lock()


def send(msg):
    line = json.dumps(msg, ensure_ascii=False, default=str)
    with out_lock:
        proto_out.write(line + "\n")
        proto_out.flush()


def event(name, **body):
    send({"type": "event", "event": name, **body})


def respond(seq, success=True, message=None, **body):
    msg = {"type": "response", "requestSeq": seq, "success": success, **body}
    if message is not None:
        msg["message"] = message
    send(msg)


def clip(s, n=PREVIEW_CHARS):
    return s if len(s) <= n else s[: n - 1] + "…"


# ------------------------------------------------------------------ values

_DEFAULT_ARGS = re.compile(r",\s*std::(allocator|less|char_traits|hash|equal_to|default_delete)<")


def _drop_default_args(s):
    """Removes template arguments that are only defaults: `, std::allocator<...>` with nested brackets."""
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
    """`std::vector<int>`, `std::map<std::string, int>`, `Node *`: as written, without default arguments."""
    try:
        s = str(t)
    except gdb.error:
        return "?"
    if rust:
        return rust.type_name(s)
    s = s.replace("std::__cxx11::", "std::")
    s = re.sub(r"std::basic_string<char(, std::char_traits<char>)?(, std::allocator<char>)?\s*>", "std::string", s)
    s = _drop_default_args(s)
    s = s.replace("std::basic_string<char>", "std::string")
    return re.sub(r"\s+>", ">", s)


def is_char(t):
    t = t.strip_typedefs()
    return t.code == gdb.TYPE_CODE_INT and t.sizeof == 1 and "char" in str(t)


def printer_of(v):
    try:
        return gdb.default_visualizer(v)
    except Exception:  # noqa: BLE001 - a broken printer must not break the debugger
        return None


def printer_children(p, limit):
    try:
        kids = p.children() if hasattr(p, "children") else None
    except Exception:  # noqa: BLE001
        return []
    if kids is None:
        return []
    out = []
    try:
        for item in itertools.islice(kids, limit):
            out.append(item)
    except Exception:  # noqa: BLE001
        pass
    return out


def printer_text(p):
    try:
        s = p.to_string()
    except Exception:  # noqa: BLE001
        return None
    if s is None:
        return None
    if isinstance(s, gdb.Value):
        return scalar_text(s)
    return str(s)


def hint_of(p):
    try:
        return p.display_hint() if hasattr(p, "display_hint") else None
    except Exception:  # noqa: BLE001
        return None


def scalar_text(v):
    t = v.type.strip_typedefs()
    try:
        if t.code == gdb.TYPE_CODE_BOOL:
            return "true" if bool(v) else "false"
        if is_char(t):
            n = int(v)
            if 32 <= n < 127:
                return "'\\''" if n == 39 else "'\\\\'" if n == 92 else f"'{chr(n)}'"
            return {0: "'\\0'", 10: "'\\n'", 9: "'\\t'", 13: "'\\r'"}.get(n, str(n))
        if t.code == gdb.TYPE_CODE_PTR:
            return NULL[0] if int(v) == 0 else hex(int(v))
        return v.format_string(raw=False, pretty_structs=False, pretty_arrays=False, repeat_threshold=0, max_elements=PREVIEW_ITEMS)
    except gdb.error:
        return "<unreadable>"


def deref(v):
    t = v.type.strip_typedefs()
    if t.code in (gdb.TYPE_CODE_REF, getattr(gdb, "TYPE_CODE_RVALUE_REF", -1)):
        return v.referenced_value()
    return v


def fields_of(v):
    """(name, value) of a struct's data members; base classes become one entry each."""
    out = []
    t = v.type.strip_typedefs()
    for f in t.fields():
        if f.is_base_class:
            name = type_name(f.type)
        elif not f.name or getattr(f, "artificial", False) or f.name.startswith("_vptr") or not hasattr(f, "bitpos"):
            continue  # unnamed, compiler-made, or a static member
        else:
            name = f.name
        try:
            out.append((name, v[f]))
        except gdb.error:
            continue
    return out


def string_of(v):
    try:
        return json.dumps(v.string(errors="replace")[:500], ensure_ascii=False)
    except (gdb.error, gdb.MemoryError, UnicodeError):
        return None


def preview(v, depth=0):
    """Short text: `3`, `[1, 2, 3]`, `{val: 1, next: →}`, `"abc"`."""
    try:
        v = deref(v)
        if rust:
            shown = rust_preview(v, depth)
            if shown is not None:
                return shown
        p = printer_of(v)
        if p is not None:
            hint = hint_of(p)
            text = printer_text(p)
            if hint == "string" or not hasattr(p, "children"):
                return text if text is not None else "{…}"
            if depth > 1:
                return "[…]" if hint == "array" else "{…}"
            kids = printer_children(p, PREVIEW_ITEMS * 2 + 1)
            more = ", …" if len(kids) > (PREVIEW_ITEMS * 2 if hint == "map" else PREVIEW_ITEMS) else ""
            if hint == "map":
                pairs = [(kids[i][1], kids[i + 1][1]) for i in range(0, min(len(kids) - 1, PREVIEW_ITEMS * 2), 2)]
                return "{" + ", ".join(f"{preview(k, depth + 1)}: {preview(x, depth + 1)}" for k, x in pairs) + more + "}"
            items = [preview(x, depth + 1) for _, x in kids[:PREVIEW_ITEMS]]
            if hint == "array" or not text or "length" in (text or "") or "with" in (text or ""):
                return "[" + ", ".join(items) + more + "]"
            return "{" + ", ".join(f"{n}: {preview(x, depth + 1)}" for n, x in kids[:PREVIEW_ITEMS]) + more + "}"
        t = v.type.strip_typedefs()
        if t.code == gdb.TYPE_CODE_PTR:
            if int(v) == 0:
                return NULL[0]
            target = t.target().strip_typedefs()
            if is_char(target):
                s = string_of(v)
                return s if s is not None else hex(int(v))
            if target.code == gdb.TYPE_CODE_FUNC or depth > 0:
                return "→"
            # What it points at: `→ {val: 1, next: →}`, or `→ 90` for an int* into an array.
            return "→ " + preview(v.dereference(), depth)
        if t.code == gdb.TYPE_CODE_ARRAY:
            n = array_length(t)
            if is_char(t.target()):
                s = string_of(v)
                if s is not None:
                    return s
            if depth > 1:
                return "[…]"
            items = [preview(v[i], depth + 1) for i in range(min(n, PREVIEW_ITEMS))]
            return "[" + ", ".join(items) + (", …" if n > PREVIEW_ITEMS else "") + "]"
        if t.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            if depth > 1:
                return "{…}"
            fs = fields_of(v)
            return "{" + ", ".join(f"{n}: {preview(x, depth + 1)}" for n, x in fs[:PREVIEW_ITEMS]) + (", …" if len(fs) > PREVIEW_ITEMS else "") + "}"
        return scalar_text(v)
    except gdb.MemoryError:
        return "<unreadable>"
    except gdb.error:
        return "<unreadable>"


def rust_preview(v, depth):
    """Rust values gdb has no printer for: `Some(5)`, `None`, `Shape::Circle(1.5)`, `(7, 'x')`, a char, a reference to a number."""
    t = v.type.strip_typedefs()
    if rust.is_char(t):
        return rust.char_text(v)
    if rust.is_enum(t):
        name, inner = rust.variant(v)
        # A Box in a variant reads as what it holds: `Some({value: 2, next: None})`.
        fields = [(n, boxed(x)) for n, x in rust.variant_fields(inner)] if inner is not None else []
        label = name if rust.is_option(t) else f"{re.sub(r'<.*$', '', type_name(v.type))}::{name}"
        if not fields:
            return label
        if depth > 1:
            return label + "(…)"
        if all(re.fullmatch(r"\d+", n) for n, _ in fields):
            return label + "(" + ", ".join(preview(x, depth + 1) for _, x in fields) + ")"
        return label + " {" + ", ".join(f"{n}: {preview(x, depth + 1)}" for n, x in fields) + "}"
    if rust.is_tuple(t):
        return "(" + ", ".join(preview(x, depth + 1) for _, x in rust.variant_fields(v)) + ")"
    if t.code == gdb.TYPE_CODE_PTR and int(v) != 0 and rust.scalar_target(t):
        return preview(v.dereference(), depth)
    return None


def boxed(v):
    try:
        t = v.type.strip_typedefs()
        if t.code == gdb.TYPE_CODE_PTR and int(v) != 0 and t.target().strip_typedefs().code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            return v.dereference()
    except (gdb.error, gdb.MemoryError):
        pass
    return v


def rust_unwrap(v):
    """Rust: what an enum, a tuple or a reference holds, as (name, value) children; None when it is not one of those."""
    t = v.type.strip_typedefs()
    if rust.is_enum(t):
        name, inner = rust.variant(v)
        fields = rust.variant_fields(inner) if inner is not None else []
        if rust.is_option(t) and name == "Some" and len(fields) == 1:
            # Some(node): the node's own fields, as a pointer shows what it points at.
            kids, _ = children(fields[0][1])
            return kids or fields
        return fields
    if rust.is_tuple(t):
        return rust.variant_fields(v)
    if t.code == gdb.TYPE_CODE_PTR and int(v) != 0 and rust.scalar_target(t):
        return []
    return None


def array_length(t):
    try:
        lo, hi = t.range()
        return max(0, hi - lo + 1)
    except (gdb.error, RuntimeError):
        return 0


def children(v):
    """(name, value) pairs one level down, and the total when it is known."""
    v = deref(v)
    if rust:
        kids = rust_unwrap(v)
        if kids is not None:
            return kids[:MAX_CHILDREN], len(kids)
    p = printer_of(v)
    if p is not None and hasattr(p, "children"):
        hint = hint_of(p)
        kids = printer_children(p, MAX_CHILDREN * (2 if hint == "map" else 1) + 1)
        if hint == "map":
            pairs = [(preview(kids[i][1], 1), kids[i + 1][1]) for i in range(0, len(kids) - 1, 2)]
            return pairs[:MAX_CHILDREN], None
        return [(n if not re.fullmatch(r"\d+", str(n)) else f"[{n}]", x) for n, x in kids[:MAX_CHILDREN]], None
    t = v.type.strip_typedefs()
    if t.code == gdb.TYPE_CODE_PTR:
        if int(v) == 0:
            return [], 0
        target = t.target().strip_typedefs()
        if target.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
            return children(v.dereference())
        return [("*", v.dereference())], 1
    if t.code == gdb.TYPE_CODE_ARRAY:
        n = array_length(t)
        return [(f"[{i}]", v[i]) for i in range(min(n, MAX_CHILDREN))], n
    if t.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
        fs = fields_of(v)
        return fs[:MAX_CHILDREN], len(fs)
    return [], 0


def expandable(v):
    try:
        v = deref(v)
        if rust:
            t = v.type.strip_typedefs()
            if rust.is_char(t):
                return False
            kids = rust_unwrap(v)
            if kids is not None:
                return len(kids) > 0 and not (rust.is_option(t) and len(kids) == 1 and not expandable(kids[0][1]) and kids[0][0] == "0")
        p = printer_of(v)
        if p is not None:
            return hasattr(p, "children") and hint_of(p) != "string" and len(printer_children(p, 1)) > 0
        t = v.type.strip_typedefs()
        if t.code == gdb.TYPE_CODE_PTR:
            if int(v) == 0 or is_char(t.target()):
                return False
            return t.target().strip_typedefs().code != gdb.TYPE_CODE_FUNC
        if t.code == gdb.TYPE_CODE_ARRAY:
            return array_length(t) > 0 and not is_char(t.target())
        return t.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION) and len(fields_of(v)) > 0
    except gdb.error:
        return False


def length_of(v):
    try:
        v = deref(v)
        p = printer_of(v)
        if p is not None:
            m = re.search(r"(?:length|with) (\d+)", printer_text(p) or "")
            return int(m.group(1)) if m else None
        t = v.type.strip_typedefs()
        if t.code == gdb.TYPE_CODE_ARRAY and not is_char(t.target()):
            return array_length(t)
    except gdb.error:
        pass
    return None


# ------------------------------------------------------------------ adapter


class Adapter:
    def __init__(self):
        self.root = "/"
        self.files = set()
        self.breakpoints = {}  # file -> {line: gdb.Breakpoint | None}
        self.refs = {}
        self.next_ref = 1
        self.stack = []  # project gdb.Frames, innermost first
        self.commands = queue.Queue()
        self.running = False
        self.pid = 0
        self.last_stop = None
        self.exit_code = None
        self.pumps = []
        self.stop_reason = None
        self.pause_requested = False
        self.panic = None
        self.errors = []

    # -- files

    def project_file(self, frame):
        try:
            sal = frame.find_sal()
            if sal.symtab is None:
                return None
            full = os.path.normpath(sal.symtab.fullname())
        except (gdb.error, RuntimeError):
            return None
        if not full.startswith(self.root + "/"):
            return None
        rel = full[len(self.root) + 1:]
        return rel if rel in self.files else None

    # -- breakpoints

    def set_breakpoints(self, file, lines):
        lines = sorted({int(n) for n in lines})
        old = self.breakpoints.pop(file, {})
        for bp in old.values():
            if bp is not None and bp.is_valid():
                bp.delete()
        placed = {}
        result = []
        for line in lines:
            bp = None
            ok = False
            actual = line
            if file in self.files:
                try:
                    bp = gdb.Breakpoint(f"{file}:{line}", internal=False)
                    locs = getattr(bp, "locations", None) or []
                    # A line without code moves to the next one with code: say which, so the editor shows it there.
                    at = [loc.source[1] for loc in locs if loc.source is not None and loc.source[1] >= line]
                    if at:
                        actual = min(at)
                    ok = bool(locs) or bp.pending is False
                except gdb.error:
                    bp = None
            placed[line] = bp
            result.append({"line": line, "verified": ok, "actual": actual} if ok else {"line": line, "verified": False})
        if placed:
            self.breakpoints[file] = placed
        return result

    # -- stopping

    def on_stop(self, ev):
        self.last_stop = ev

    def on_thread(self, ev):
        # The program's pid, known from its first thread: `pause` interrupts it by pid.
        try:
            self.pid = ev.inferior_thread.ptid[0] or self.pid
        except (AttributeError, RuntimeError):
            pass

    def on_exit(self, ev):
        self.exit_code = ev.exit_code if hasattr(ev, "exit_code") else None

    def project_stack(self):
        frames = []
        f = gdb.newest_frame()
        while f is not None and len(frames) < MAX_FRAMES:
            if self.project_file(f):
                frames.append(f)
            try:
                f = f.older()
            except gdb.error:
                break
        return frames

    def reason(self):
        ev = self.last_stop
        if isinstance(ev, gdb.SignalEvent):
            sig = ev.stop_signal
            if sig == "SIGINT" and self.pause_requested:
                return "pause", None
            names = {
                "SIGSEGV": "Segmentation fault: the program read or wrote memory it does not own (a null or dangling pointer, or an index out of range)",
                "SIGFPE": "Arithmetic error (SIGFPE), such as a division by zero",
                "SIGABRT": "The program aborted (SIGABRT): an assert failed or an exception was not caught",
                "SIGBUS": "Bus error (SIGBUS): a bad memory access",
                "SIGILL": "Illegal instruction (SIGILL)",
            }
            return "exception", names.get(sig, f"The program received {sig}")
        if isinstance(ev, gdb.BreakpointEvent):
            if self.panic is not None and self.panic in ev.breakpoints:
                return "exception", self.panic_message()
            return "breakpoint", None
        return ("pause" if self.pause_requested else "step"), None

    def panic_message(self):
        """`panic: attempt to subtract with overflow`, from what the panic printed on stderr."""
        for _ in range(25):
            m = re.search(r"panicked at [^\n]*:\n(.*)", "".join(self.errors))
            if m:
                return f"panic: {m.group(1).strip()}"
            time.sleep(0.02)
        return "panic"

    def frame_name(self, f):
        try:
            fn = f.function()
            name = fn.print_name if fn is not None else (f.name() or "??")
        except (gdb.error, RuntimeError):
            name = f.name() or "??"
        if rust:
            return rust.frame_name(name, f)
        # `Stack<int>::push(int)` reads as `Stack<int>::push`.
        depth = 0
        for i, ch in enumerate(name):
            if ch in "<":
                depth += 1
            elif ch == ">":
                depth -= 1
            elif ch == "(" and depth == 0:
                return name[:i]
        return name

    def announce(self, reason, description):
        self.stack = self.project_stack()
        self.refs.clear()
        self.next_ref = 1
        self.stop_reason = reason
        frames = []
        for i, f in enumerate(self.stack):
            frames.append({
                "id": i,
                "name": self.frame_name(f) if rust else self.frame_name(f).replace("::", "."),
                "file": self.project_file(f),
                "line": f.find_sal().line,
                "localsRef": self.register(("frame", f)),
            })
        body = {"reason": reason, "thread": THREAD, "frames": frames}
        if description:
            body["description"] = description
        event("stopped", **body)

    # -- variables

    def register(self, target):
        ref = self.next_ref
        self.next_ref += 1
        self.refs[ref] = target
        return ref

    def format(self, v):
        try:
            d = {"value": clip(preview(v)), "type": type_name(deref(v).type), "ref": self.register(("value", v)) if expandable(v) else 0}
            n = length_of(v)
            if n is not None:
                d["length"] = n
            return d
        except gdb.error as e:
            return {"value": f"<{e}>", "type": "", "ref": 0}

    def describe(self, name, v):
        d = self.format(v)
        d["name"] = name
        return d

    def frame_vars(self, frame):
        """Arguments and the locals declared at or above the current line, innermost block first."""
        out = []
        seen = set()
        try:
            block = frame.block()
            line = frame.find_sal().line
        except (gdb.error, RuntimeError):
            return out
        blocks = []
        while block is not None:
            blocks.append(block)
            if block.function is not None:
                break
            block = block.superblock
        args = []
        for b in reversed(blocks):
            for sym in b:
                if not (sym.is_variable or sym.is_argument) or sym.name in seen:
                    continue
                if rust and rust.hidden(sym):
                    continue
                if sym.is_variable and not sym.is_argument and sym.line >= line:
                    continue  # its declaration has not run yet: the value would be garbage
                if sym.addr_class == gdb.SYMBOL_LOC_STATIC:
                    continue
                try:
                    value = sym.value(frame)
                except (gdb.error, RuntimeError):
                    continue
                seen.add(sym.name)
                (args if sym.is_argument else out).append((sym.name, value))
        return [self.describe(n, v) for n, v in (args + out)[:MAX_CHILDREN]]

    def variables(self, ref):
        target = self.refs.get(ref)
        if target is None:
            raise RuntimeError("variable reference expired; the program has resumed")
        kind, obj = target
        if kind == "frame":
            return self.frame_vars(obj)
        items, total = children(obj)
        out = [self.describe(str(n), v) for n, v in items]
        if total is not None and total > len(items):
            out.append({"name": "…", "value": f"{total - len(items)} more", "type": "", "ref": 0})
        return out

    def evaluate(self, expression, index):
        if not (0 <= index < len(self.stack)):
            return {"error": "That frame is no longer available."}
        code = re.sub(r"'(\\.|[^'])*'|\"(\\.|[^\"])*\"", "", expression)
        if re.search(r"(?<![=!<>])=(?!=)|\+\+|--", code):
            return {"error": "Watches do not change the program: assignments and ++/-- are not evaluated."}
        frame = self.stack[index]
        try:
            frame.select()
            value = gdb.parse_and_eval(expression)
            value.fetch_lazy()
            return {"result": self.format(value)}
        except gdb.error as e:
            text = str(e)
            if "may-call-functions" in text or "call" in text and "function" in text or "Cannot evaluate function" in text or "Could not find function" in text:
                text = "Watches do not call functions, because that would run program code."
            return {"error": text}
        except gdb.MemoryError as e:
            return {"error": f"cannot read that memory: {e}"}

    # -- commands

    def handle(self, req, stopped):
        """Handles one command while stopped. Returns the gdb command that resumes, or None."""
        seq, cmd = req.get("seq"), req.get("cmd")
        if cmd == "setBreakpoints":
            file = str(req.get("file") or "")
            respond(seq, file=file, breakpoints=self.set_breakpoints(file, req.get("lines") or []))
        elif cmd == "pause":
            respond(seq)
        elif cmd in ("continue", "stepOver", "stepIn", "stepOut"):
            respond(seq)
            if self.stop_reason == "exception":
                return "continue"
            if cmd == "stepOut" and len(self.stack) <= 1:
                return "continue"
            return {"continue": "continue", "stepOver": "next", "stepIn": "step", "stepOut": "finish"}[cmd]
        elif cmd == "variables":
            ref = req.get("ref")
            respond(seq, ref=ref, variables=self.variables(ref))
        elif cmd == "evaluate":
            expr = str(req.get("expression", ""))
            respond(seq, expression=expr, **self.evaluate(expr, req.get("frame") or 0))
        elif cmd == "terminate":
            respond(seq)
            self.kill()
            os._exit(0)
        else:
            respond(seq, False, f"unknown command: {cmd}")
        return None

    def safe_handle(self, req, stopped=True):
        try:
            return self.handle(req, stopped)
        except Exception as e:  # noqa: BLE001 - report every failure to the client
            respond(req.get("seq"), False, f"{type(e).__name__}: {e}")
            return None

    def read_commands(self):
        """Runs on its own thread: queues commands; while the program runs, `pause` interrupts it."""
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                if not isinstance(req, dict):
                    raise ValueError("expected an object")
            except ValueError as e:
                event("error", message=f"invalid request: {e}")
                continue
            if req.get("cmd") == "terminate" and self.running:
                respond(req.get("seq"))
                self.kill()
                os._exit(0)
            if self.running and req.get("cmd") in ("pause", "setBreakpoints") and self.pid:
                # Stop the program so gdb can act; a breakpoint change resumes it right after.
                if req.get("cmd") == "pause":
                    self.pause_requested = True
                else:
                    req["_resume"] = True
                try:
                    os.kill(self.pid, signal.SIGINT)
                except OSError:
                    pass
            self.commands.put(req)
        self.kill()
        os._exit(0)

    def kill(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass

    # -- output

    def pump(self, path, stream):
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            return
        import codecs
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            text = decoder.decode(data, final=not data)
            if text:
                if stream == "stderr":
                    self.errors.append(text)
                event("output", stream=stream, text=text)
            if not data:
                break
        os.close(fd)

    # -- running

    def launch(self, req):
        self.root = os.path.normpath(req.get("root") or os.getcwd())
        global rust
        if req.get("language") == "c":
            NULL[0] = "NULL"
        if req.get("language") == "rust":
            NULL[0] = "None"
            sys.path.insert(0, "/tmp/cwdbg")
            import cw_gdb_rust

            rust = cw_gdb_rust
        self.files = {str(f) for f in req.get("files") or []}
        os.chdir(self.root)
        for cmd in (
            "set confirm off",
            "set pagination off",
            "set width 0",
            "set print pretty off",
            "set breakpoint pending off",
            "set disable-randomization off",
            "set may-call-functions off",
            "set startup-with-shell on",
            # Step only through the program's own code, never into the library's headers.
            "skip -gfi /usr/**",
        ):
            try:
                gdb.execute(cmd, to_string=True)
            except gdb.error:
                pass
        for path in [] if rust else sorted(glob.glob("/usr/local/share/gcc-*/python")) + ["/usr/share/gcc/python"]:
            if os.path.isdir(os.path.join(path, "libstdcxx")):
                sys.path.insert(0, path)
                try:
                    from libstdcxx.v6.printers import register_libstdcxx_printers
                    register_libstdcxx_printers(None)
                except Exception:  # noqa: BLE001 - values then show without the printers
                    pass
                break
        gdb.execute(f"file {req.get('program', 'out/main')}", to_string=True)
        if rust:
            rust.setup()
            try:
                # A panic stops the program where its own code panicked, with its message, as an exception does elsewhere.
                self.panic = gdb.Breakpoint(rust.PANIC_SYMBOL, internal=True)
            except gdb.error:
                self.panic = None
        gdb.events.stop.connect(self.on_stop)
        gdb.events.exited.connect(self.on_exit)
        gdb.events.new_thread.connect(self.on_thread)
        for file, lines in (req.get("breakpoints") or {}).items():
            if lines:
                event("breakpoints", file=file, breakpoints=self.set_breakpoints(file, lines))
        for path in (OUT_FIFO, ERR_FIFO):
            if not os.path.exists(path):
                os.mkfifo(path)
        for path, stream in ((OUT_FIFO, "stdout"), (ERR_FIFO, "stderr")):
            t = threading.Thread(target=self.pump, args=(path, stream), daemon=True)
            t.start()
            self.pumps.append(t)
        stdin = req.get("stdinPath")
        stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
        # Unbuffered like a terminal, so output shows as each line runs.
        gdb.execute("set exec-wrapper stdbuf -o0 -e0", to_string=True)
        self.run_command = f"run < {stdin} > {OUT_FIFO} 2> {ERR_FIFO}"

    def alive(self):
        try:
            inf = gdb.selected_inferior()
            return inf.pid != 0 and inf.is_valid()
        except (gdb.error, RuntimeError):
            return False

    def resume(self, command):
        """Runs one gdb command that lets the program go, until it stops or ends."""
        self.last_stop = None
        self.running = True
        try:
            gdb.execute(command, to_string=True)
        except gdb.error as e:
            if self.alive():
                event("error", message=f"{command}: {e}")
        finally:
            self.running = False
        if self.alive():
            self.pid = gdb.selected_inferior().pid

    def run(self):
        self.resume(self.run_command)
        stepping = None
        while self.alive():
            reason, description = self.reason()
            top = gdb.newest_frame()
            in_project = self.project_file(top) is not None
            # Commands that came in while it ran: breakpoint changes apply now.
            pending = []
            while not self.commands.empty():
                req = self.commands.get_nowait()
                if req.get("cmd") == "setBreakpoints":
                    self.safe_handle(req)
                elif req.get("cmd") == "pause":
                    respond(req.get("seq"))
                else:
                    pending.append(req)
            for req in pending:
                self.commands.put(req)
            if isinstance(self.last_stop, gdb.SignalEvent) and self.last_stop.stop_signal == "SIGINT" and not self.pause_requested:
                # Only a breakpoint change stopped it: carry on as before.
                self.resume(stepping or "continue")
                continue
            if not in_project and reason in ("step", "pause"):
                # Outside the program's code (a library, or after main): back to it, or run on.
                if self.project_stack():
                    self.resume("finish")
                else:
                    self.resume("continue")
                continue
            self.pause_requested = False
            self.announce(reason, description)
            command = None
            while command is None:
                req = self.commands.get()
                command = self.safe_handle(req)
            event("continued")
            stepping = command if command in ("next", "step") else None
            self.resume(command)
        return self.exit_code

    def finish(self, code):
        for t in self.pumps:
            t.join(3)
        event("exited", exitCode=code if code is not None else 1)
        proto_out.flush()
        os._exit(0)


def main():
    adapter = Adapter()
    launch = None
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError as e:
            event("error", message=f"invalid request: {e}")
            continue
        if isinstance(req, dict) and req.get("cmd") == "launch":
            launch = req
            break
        respond(req.get("seq") if isinstance(req, dict) else None, False, "program not launched")
    if launch is None:
        os._exit(0)
    try:
        adapter.launch(launch)
    except Exception as e:  # noqa: BLE001
        respond(launch.get("seq"), False, f"{type(e).__name__}: {e}")
        proto_out.flush()
        os._exit(1)
    threading.Thread(target=adapter.read_commands, name="cw-commands", daemon=True).start()
    respond(launch.get("seq"))
    event("continued")
    code = adapter.run()
    if code is None:
        try:
            sig = gdb.parse_and_eval("$_exitsignal")
            code = 128 + int(sig) if sig.type.code != gdb.TYPE_CODE_VOID else 0
        except gdb.error:
            code = 0
    adapter.finish(code)


main()
