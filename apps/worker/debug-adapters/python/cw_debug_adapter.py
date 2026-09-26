"""Code Workspace Python debug adapter.

Runs inside the sandbox and executes the program in this same interpreter
under a line tracer (sys.settrace). It speaks newline-delimited JSON on the
original stdin/stdout, the same protocol as the Java adapter:

  in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
       | setBreakpoints | variables | evaluate | terminate
  out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}

The program gets its own stdin (the run's input file) and its stdout/stderr
are pipes relayed as "output" events, so program output never mixes with
the protocol. Inspecting values never runs program code: previews and
children are read with built-in slot functions, and watch expressions use a
small evaluator that rejects calls into user-defined code.
"""

import ast
import atexit
import builtins
import codecs
import collections
import enum
import inspect
import io
import itertools
import json
import os
import queue
import runpy
import select
import sys
import threading
import traceback
import types

MAX_CHILDREN = 200
PREVIEW_ITEMS = 10
PREVIEW_CHARS = 200
THREAD_NAME = "MainThread"


class EvalError(Exception):
    pass


# ----------------------------------------------------------------- values

SCALARS = (bool, int, float, complex, str, bytes, bytearray)
SEQUENCES = (list, tuple, collections.deque, set, frozenset)


def base_of(v, bases):
    for b in bases:
        if isinstance(v, b):
            return b
    return None


def scalar_repr(v):
    """repr() of a built-in scalar through the built-in slot, never an override."""
    base = type(None) if v is None else base_of(v, SCALARS)
    if base is None:
        return None
    if v is None:
        return "None"
    try:
        if base is str:
            s = str.__str__(v)
            return repr(s) if len(s) <= 500 else repr(s[:500]) + "…"
        if base in (bytes, bytearray):
            b = bytes(v[:200]) if len(v) > 200 else bytes(v)
            return repr(b) + ("…" if len(v) > 200 else "")
        if base is bool:
            return "True" if v else "False"
        text = base.__repr__(v)
    except ValueError:
        # int too large to print (sys.set_int_max_str_digits).
        return f"<int with {int.bit_length(v)} bits>"
    return text if len(text) <= 500 else text[:500] + "…"


def type_name(v):
    t = type(v)
    return t.__qualname__ if t.__module__ in ("builtins", "__main__") else f"{t.__module__}.{t.__qualname__}"


def instance_fields(v):
    """Instance attributes from __dict__ and __slots__ without invoking __getattr__ or properties."""
    fields = []
    try:
        d = object.__getattribute__(v, "__dict__")
    except (AttributeError, TypeError):
        d = None
    if type(d) is dict:
        fields.extend((k, val) for k, val in dict.items(d) if type(k) is str)
    seen = {k for k, _ in fields}
    for cls in type(v).__mro__:
        for name, desc in list(vars(cls).items()):
            if type(desc) is types.MemberDescriptorType and name not in seen and not name.startswith("__"):
                try:
                    fields.append((name, desc.__get__(v, type(v))))
                    seen.add(name)
                except AttributeError:
                    pass
    return fields


def is_enum_member(v):
    return isinstance(v, enum.Enum)


def seq_items(v, limit):
    base = base_of(v, SEQUENCES)
    return list(itertools.islice(base.__iter__(v), limit))


def seq_len(v):
    return base_of(v, SEQUENCES).__len__(v)


def preview(v, depth=0):
    if is_enum_member(v):
        return f"{type(v).__qualname__}.{v._name_}"
    s = scalar_repr(v)
    if s is not None:
        if isinstance(v, str) and len(s) > 60:
            s = s[:60] + "…"
        return s
    if isinstance(v, dict):
        if depth >= 2:
            return "{…}"
        n = dict.__len__(v)
        parts = [f"{preview(k, depth + 1)}: {preview(val, depth + 1)}" for k, val in itertools.islice(dict.items(v), PREVIEW_ITEMS)]
        if n > PREVIEW_ITEMS:
            parts.append("…")
        return "{" + ", ".join(parts) + "}"
    base = base_of(v, SEQUENCES)
    if base is not None:
        n = seq_len(v)
        opener, closer = {list: ("[", "]"), tuple: ("(", ")"), set: ("{", "}"), frozenset: ("frozenset({", "})"), collections.deque: ("deque([", "])")}[base]
        if base is set and n == 0:
            return "set()"
        if depth >= 2:
            return opener + "…" + closer
        parts = [preview(x, depth + 1) for x in seq_items(v, PREVIEW_ITEMS)]
        if n > PREVIEW_ITEMS:
            parts.append("…")
        text = ", ".join(parts)
        if base is tuple and n == 1:
            text += ","
        return opener + text + closer
    if isinstance(v, range):
        return range.__repr__(v)
    if isinstance(v, type):
        return f"<class '{v.__qualname__}'>"
    if isinstance(v, types.ModuleType):
        return f"<module '{v.__name__}'>"
    if isinstance(v, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
        return f"<function {getattr(v, '__qualname__', '?')}>"
    if isinstance(v, BaseException):
        args = BaseException.__getattribute__(v, "args")
        inner = preview(args[0], depth + 1) if len(args) == 1 else ", ".join(preview(a, depth + 1) for a in args[:PREVIEW_ITEMS])
        return f"{type(v).__qualname__}({inner})"
    # Plain objects: show their fields rather than calling a user __repr__.
    if depth >= 1:
        return f"{type(v).__qualname__}(…)"
    fields = instance_fields(v)
    parts = [f"{k}={preview(val, depth + 1)}" for k, val in fields[:PREVIEW_ITEMS]]
    if len(fields) > PREVIEW_ITEMS:
        parts.append("…")
    return f"{type(v).__qualname__}(" + ", ".join(parts) + ")"


def clip(text):
    return text if len(text) <= PREVIEW_CHARS else text[:PREVIEW_CHARS] + "…"


def expandable_count(v):
    """Number of children, or None when the value has none to show."""
    if is_enum_member(v) or scalar_repr(v) is not None or isinstance(v, (type, types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType, range)):
        return None
    if isinstance(v, dict):
        return dict.__len__(v)
    if base_of(v, SEQUENCES) is not None:
        return seq_len(v)
    if isinstance(v, BaseException):
        return len(BaseException.__getattribute__(v, "args")) + len(instance_fields(v))
    return len(instance_fields(v))


def children(v):
    out = []
    if isinstance(v, dict):
        for k, val in itertools.islice(dict.items(v), MAX_CHILDREN):
            out.append((clip(preview(k, 1)), val))
        total = dict.__len__(v)
    elif base_of(v, SEQUENCES) is not None:
        out = [(f"[{i}]", x) for i, x in enumerate(seq_items(v, MAX_CHILDREN))]
        total = seq_len(v)
    elif isinstance(v, BaseException):
        out = [(f"args[{i}]", a) for i, a in enumerate(BaseException.__getattribute__(v, "args"))] + instance_fields(v)
        total = len(out)
    else:
        out = instance_fields(v)
        total = len(out)
        out = out[:MAX_CHILDREN]
    return out, total


# ------------------------------------------------------------- evaluator

SAFE_BUILTINS = {
    name: getattr(builtins, name)
    for name in ("len", "abs", "min", "max", "sum", "round", "sorted", "str", "int", "float", "bool", "list", "tuple", "set",
                 "dict", "range", "divmod", "any", "all", "ord", "chr", "hex", "bin", "oct", "type", "isinstance", "repr")
}
MAX_RESULT_ITEMS = 1_000_000


def is_plain(v, budget=None):
    """True for built-in scalars and built-in containers made only of plain values."""
    if budget is None:
        budget = [10_000]
    budget[0] -= 1
    if budget[0] < 0:
        return False
    if v is None or type(v) in SCALARS or type(v) is range:
        return True
    if type(v) is dict:
        return all(is_plain(k, budget) and is_plain(x, budget) for k, x in dict.items(v))
    if type(v) in SEQUENCES:
        return all(is_plain(x, budget) for x in seq_items(v, 10_001))
    return False


class Evaluator:
    """Evaluates a watch expression against a frame without running program code."""

    def __init__(self, frame):
        self.locals = frame.f_locals
        self.globals = frame.f_globals

    def run(self, source):
        try:
            tree = ast.parse(source.strip(), mode="eval")
        except SyntaxError as e:
            raise EvalError(f"syntax error: {e.msg}") from None
        try:
            return self.eval(tree.body)
        except EvalError:
            raise
        except RecursionError:
            raise EvalError("expression is too deeply nested") from None
        except Exception as e:
            raise EvalError(f"{type(e).__name__}: {e}") from None

    def lookup(self, name):
        if name in self.locals:
            return self.locals[name]
        if name in self.globals:
            return self.globals[name]
        if name in SAFE_BUILTINS:
            return SAFE_BUILTINS[name]
        if name in ("True", "False", "None"):
            return {"True": True, "False": False, "None": None}[name]
        raise EvalError(f"name '{name}' is not defined")

    def plain(self, *values):
        for v in values:
            if not is_plain(v):
                raise EvalError(f"operations on {type(v).__qualname__} objects are not evaluated, because they would run program code")

    def truth(self, v):
        if is_plain(v):
            return bool(v)
        t = type(v)
        if inspect.getattr_static(t, "__bool__", None) is None and inspect.getattr_static(t, "__len__", None) is None:
            return True
        raise EvalError(f"the truth value of {t.__qualname__} objects is not evaluated, because it would run program code")

    def eval(self, node):
        method = getattr(self, "eval_" + type(node).__name__, None)
        if method is None:
            raise EvalError(f"{type(node).__name__} expressions are not supported in watches")
        return method(node)

    def eval_Constant(self, node):
        return node.value

    def eval_Name(self, node):
        return self.lookup(node.id)

    def eval_List(self, node):
        return [self.eval(e) for e in node.elts]

    def eval_Tuple(self, node):
        return tuple(self.eval(e) for e in node.elts)

    def eval_Set(self, node):
        items = [self.eval(e) for e in node.elts]
        self.plain(*items)
        return set(items)

    def eval_Dict(self, node):
        if any(k is None for k in node.keys):
            raise EvalError("dict unpacking is not supported in watches")
        keys = [self.eval(k) for k in node.keys]
        self.plain(*keys)
        return dict(zip(keys, (self.eval(v) for v in node.values)))

    def eval_Attribute(self, node):
        obj = self.eval(node.value)
        name = node.attr
        if name.startswith("__"):
            raise EvalError("special attributes are not supported in watches")
        if isinstance(obj, types.ModuleType):
            d = object.__getattribute__(obj, "__dict__")
            if name in d:
                return d[name]
            raise EvalError(f"module '{obj.__name__}' has no attribute '{name}'")
        for field, value in instance_fields(obj) if not isinstance(obj, type) else []:
            if field == name:
                return value
        try:
            attr = inspect.getattr_static(obj, name)
        except AttributeError:
            raise EvalError(f"'{type(obj).__qualname__}' object has no attribute '{name}'") from None
        if isinstance(attr, (property, types.FunctionType, types.MethodDescriptorType, types.BuiltinFunctionType,
                             types.WrapperDescriptorType, types.GetSetDescriptorType, classmethod, staticmethod)) or hasattr(type(attr), "__get__"):
            raise EvalError(f"'{name}' is a method or property; watches do not run program code")
        return attr

    def eval_Subscript(self, node):
        obj = self.eval(node.value)
        key = self.eval(node.slice)
        if type(key) is not slice:
            self.plain(key)
        if isinstance(obj, dict):
            missing = object()
            value = dict.get(obj, key, missing)
            if value is missing:
                raise EvalError(f"KeyError: {preview(key)}")
            return value
        for base in (list, tuple, str, bytes, bytearray, range, collections.deque):
            if isinstance(obj, base):
                try:
                    return base.__getitem__(obj, key)
                except IndexError:
                    raise EvalError(f"index {preview(key)} is out of range (length {base.__len__(obj)})") from None
        raise EvalError(f"{type(obj).__qualname__} objects cannot be indexed in watches")

    def eval_Slice(self, node):
        parts = [None if p is None else self.eval(p) for p in (node.lower, node.upper, node.step)]
        for p in parts:
            if p is not None and type(p) is not int:
                raise EvalError("slice indices must be integers")
        return slice(*parts)

    def eval_UnaryOp(self, node):
        v = self.eval(node.operand)
        if isinstance(node.op, ast.Not):
            return not self.truth(v)
        self.plain(v)
        return {ast.USub: lambda x: -x, ast.UAdd: lambda x: +x, ast.Invert: lambda x: ~x}[type(node.op)](v)

    def eval_BinOp(self, node):
        a, b = self.eval(node.left), self.eval(node.right)
        self.plain(a, b)
        op = type(node.op)
        self.guard_size(op, a, b)
        fn = {
            ast.Add: lambda x, y: x + y, ast.Sub: lambda x, y: x - y, ast.Mult: lambda x, y: x * y,
            ast.Div: lambda x, y: x / y, ast.FloorDiv: lambda x, y: x // y, ast.Mod: lambda x, y: x % y,
            ast.Pow: lambda x, y: x ** y, ast.LShift: lambda x, y: x << y, ast.RShift: lambda x, y: x >> y,
            ast.BitAnd: lambda x, y: x & y, ast.BitOr: lambda x, y: x | y, ast.BitXor: lambda x, y: x ^ y,
        }.get(op)
        if fn is None:
            raise EvalError("this operator is not supported in watches")
        return fn(a, b)

    @staticmethod
    def guard_size(op, a, b):
        def big_int(x):
            return type(x) is int and x.bit_length() > 64

        if op is ast.Pow and type(a) is int and type(b) is int and b > 0 and abs(a) > 1 and b * max(a.bit_length(), 1) > 100_000:
            raise EvalError("the result would be too large")
        if op is ast.LShift and type(b) is int and b > 100_000:
            raise EvalError("the result would be too large")
        if op is ast.Mult:
            for seq, n in ((a, b), (b, a)):
                if isinstance(seq, (str, bytes, list, tuple)) and type(n) is int and (big_int(n) or len(seq) * n > MAX_RESULT_ITEMS):
                    raise EvalError("the result would be too large")

    def eval_Compare(self, node):
        left = self.eval(node.left)
        for op, right_node in zip(node.ops, node.comparators):
            right = self.eval(right_node)
            if isinstance(op, ast.Is):
                ok = left is right
            elif isinstance(op, ast.IsNot):
                ok = left is not right
            else:
                self.plain(left, right)
                ok = {
                    ast.Eq: lambda x, y: x == y, ast.NotEq: lambda x, y: x != y, ast.Lt: lambda x, y: x < y,
                    ast.LtE: lambda x, y: x <= y, ast.Gt: lambda x, y: x > y, ast.GtE: lambda x, y: x >= y,
                    ast.In: lambda x, y: x in y, ast.NotIn: lambda x, y: x not in y,
                }[type(op)](left, right)
            if not ok:
                return False
            left = right
        return True

    def eval_BoolOp(self, node):
        is_and = isinstance(node.op, ast.And)
        value = None
        for v in node.values:
            value = self.eval(v)
            if self.truth(value) != is_and:
                return value
        return value

    def eval_IfExp(self, node):
        return self.eval(node.body) if self.truth(self.eval(node.test)) else self.eval(node.orelse)

    def eval_JoinedStr(self, node):
        out = []
        for part in node.values:
            if isinstance(part, ast.Constant):
                out.append(part.value)
                continue
            v = self.eval(part.value)
            self.plain(v)
            spec = self.eval(part.format_spec) if part.format_spec else ""
            v = {-1: v, 115: str(v), 114: repr(v), 97: ascii(v)}[part.conversion]
            out.append(format(v, spec))
        return "".join(out)

    def eval_Call(self, node):
        if not isinstance(node.func, ast.Name) or node.func.id not in SAFE_BUILTINS or self.lookup(node.func.id) is not SAFE_BUILTINS[node.func.id]:
            raise EvalError("only built-in functions such as len(), min() and abs() can be called in watches")
        name = node.func.id
        if any(isinstance(a, ast.Starred) for a in node.args):
            raise EvalError("argument unpacking is not supported in watches")
        args = [self.eval(a) for a in node.args]
        kwargs = {}
        for kw in node.keywords:
            if name == "sorted" and kw.arg == "reverse" or name == "round" and kw.arg == "ndigits":
                kwargs[kw.arg] = self.eval(kw.value)
            else:
                raise EvalError(f"keyword arguments are not supported for {name}() in watches")
        fn = SAFE_BUILTINS[name]
        if name in ("type",):
            if len(args) != 1:
                raise EvalError("type() takes one argument in watches")
            return type(args[0])
        if name == "len":
            if len(args) != 1:
                raise EvalError("len() takes one argument")
            v = args[0]
            for base in (str, bytes, bytearray, list, tuple, dict, set, frozenset, collections.deque, range):
                if isinstance(v, base):
                    return base.__len__(v)
            raise EvalError(f"len() of {type(v).__qualname__} objects is not evaluated, because it would run program code")
        if name == "isinstance":
            if len(args) != 2:
                raise EvalError("isinstance() takes two arguments")
            kinds = args[1] if isinstance(args[1], tuple) else (args[1],)
            if not all(isinstance(k, type) and type(k) is type for k in kinds):
                raise EvalError("isinstance() needs classes as its second argument")
            return isinstance(args[0], args[1])
        if name == "repr":
            if len(args) != 1:
                raise EvalError("repr() takes one argument")
            return clip(preview(args[0]))
        self.plain(*args, *kwargs.values())
        for a in args:
            if type(a) is range and name in ("list", "tuple", "set", "sorted", "sum", "min", "max", "any", "all", "dict") and len(a) > MAX_RESULT_ITEMS:
                raise EvalError("the result would be too large")
        return fn(*args, **kwargs)


# ---------------------------------------------------------------- adapter


class WatchedStdin(io.FileIO):
    """The program's raw stdin. Reports when a read is about to block, so the
    worker can show that the program is waiting for input (and not count the
    wait as running time)."""

    def __init__(self, fd, report):
        super().__init__(fd, "r", closefd=False)
        self._report = report

    def readinto(self, buffer):
        try:
            ready = select.select([self.fileno()], [], [], 0)[0]
        except (OSError, ValueError):
            ready = True  # select unsupported for this fd (e.g. a file on Windows)
        if ready:
            return super().readinto(buffer)
        self._report(True)
        try:
            return super().readinto(buffer)
        finally:
            self._report(False)


class Adapter:
    def __init__(self, proto_out):
        self.out = proto_out
        self.out_lock = threading.Lock()
        self.state = threading.RLock()
        self.root = os.getcwd()
        self.files = set()  # project-relative paths
        self.code_files = {}  # code object -> project path or None
        self.breakpoints = {}  # project path -> set of lines
        self.executable = {}  # project path -> set of lines with code
        self.paused = False
        self.commands = queue.Queue()
        self.mode = None  # None | "in" | "over" | "out" | "pause"
        self.step_frame = None
        self.stack = []  # [(frame, line)] at the current stop
        self.stop_reason = None
        self.refs = {}
        self.next_ref = 1
        self.main_ident = threading.get_ident()
        self.pumps = []

    # -- protocol

    def send(self, msg):
        line = json.dumps(msg, ensure_ascii=False, default=str)
        with self.out_lock:
            self.out.write(line + "\n")
            self.out.flush()

    def event(self, name, **body):
        self.send({"type": "event", "event": name, **body})

    def respond(self, seq, success=True, message=None, **body):
        msg = {"type": "response", "requestSeq": seq, "success": success, **body}
        if message is not None:
            msg["message"] = message
        self.send(msg)

    def read_commands(self, stream):
        for line in stream:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                if not isinstance(req, dict):
                    raise ValueError("expected an object")
            except ValueError as e:
                self.event("error", message=f"invalid request: {e}")
                continue
            with self.state:
                if self.paused:
                    self.commands.put(req)
                    continue
            self.safe_handle(req, paused=False)
        # The worker closed the channel: the session is over.
        os._exit(0)

    def safe_handle(self, req, paused):
        try:
            return self.handle(req, paused)
        except Exception as e:  # noqa: BLE001 - report every failure to the client
            self.respond(req.get("seq"), False, f"{type(e).__name__}: {e}")
            return False

    def handle(self, req, paused):
        """Handles one command. Returns True when the program should resume."""
        seq, cmd = req.get("seq"), req.get("cmd")
        if cmd == "setBreakpoints":
            file = req.get("file")
            lines = req.get("lines") or []
            self.respond(seq, file=file, breakpoints=self.set_breakpoints(file, lines))
        elif cmd == "pause":
            if not paused:
                with self.state:
                    self.mode = "pause"
                    self.step_frame = None
                self.arm_running_frames()
            self.respond(seq)
        elif cmd in ("continue", "stepOver", "stepIn", "stepOut"):
            if not paused:
                if cmd == "continue":
                    self.respond(seq)
                else:
                    self.respond(seq, False, "The program is not paused.")
                return False
            if self.stop_reason != "exception":
                top = self.stack[0][0] if self.stack else None
                self.mode = {"continue": None, "stepOver": "over", "stepIn": "in", "stepOut": "out"}[cmd]
                self.step_frame = top if cmd in ("stepOver", "stepOut") else None
            self.respond(seq)
            return True
        elif cmd == "variables":
            if not paused:
                self.respond(seq, False, "The program is running.")
            else:
                ref = req.get("ref")
                self.respond(seq, ref=ref, variables=self.variables(ref))
        elif cmd == "evaluate":
            expr = str(req.get("expression", ""))
            if not paused:
                self.respond(seq, expression=expr, error="The program is running.")
                return False
            index = req.get("frame") or 0
            if not (0 <= index < len(self.stack)):
                self.respond(seq, expression=expr, error="That frame is no longer available.")
                return False
            try:
                value = Evaluator(self.stack[index][0]).run(expr)
                self.respond(seq, expression=expr, result=self.format(value))
            except EvalError as e:
                self.respond(seq, expression=expr, error=str(e))
        elif cmd == "terminate":
            self.respond(seq)
            self.out.flush()
            os._exit(0)
        else:
            self.respond(seq, False, f"unknown command: {cmd}")
        return False

    # -- files and breakpoints

    def project_file(self, code):
        try:
            return self.code_files[code]
        except KeyError:
            pass
        path = None
        name = code.co_filename
        if not name.startswith("<"):
            try:
                rel = os.path.relpath(os.path.abspath(name), self.root).replace(os.sep, "/")
            except ValueError:
                rel = None  # different drive (Windows)
            if rel in self.files:
                path = rel
        self.code_files[code] = path
        return path

    def executable_lines(self, file):
        if file not in self.executable:
            lines = set()
            try:
                with open(os.path.join(self.root, file), encoding="utf-8") as f:
                    code = compile(f.read(), file, "exec")
                todo = [code]
                while todo:
                    c = todo.pop()
                    lines.update(line for _, _, line in c.co_lines() if line)
                    todo.extend(k for k in c.co_consts if isinstance(k, types.CodeType))
            except (OSError, SyntaxError, ValueError):
                pass
            self.executable[file] = lines
        return self.executable[file]

    def set_breakpoints(self, file, lines):
        lines = sorted({int(n) for n in lines})
        with self.state:
            if lines:
                self.breakpoints[file] = set(lines)
            else:
                self.breakpoints.pop(file, None)
        if lines:
            self.arm_running_frames()
        ok = self.executable_lines(file) if file in self.files else set()
        return [{"line": n, "verified": n in ok} for n in lines]

    def arm(self, frame):
        frame.f_trace_lines = True
        frame.f_trace = self.trace_local

    def arm_running_frames(self):
        """Attaches the line tracer to project frames already running on the main thread."""
        f = sys._current_frames().get(self.main_ident)
        while f is not None:
            if self.project_file(f.f_code):
                self.arm(f)
            f = f.f_back

    # -- tracing

    def trace_call(self, frame, event, arg):
        if event != "call":
            return None
        file = self.project_file(frame.f_code)
        if file is None:
            return None
        if self.mode is not None or file in self.breakpoints:
            return self.trace_local
        return None

    def trace_local(self, frame, event, arg):
        try:
            if event == "line":
                mode = self.mode
                if mode == "pause":
                    self.stop(frame, "pause")
                elif mode == "in" or (mode == "over" and frame is self.step_frame):
                    self.stop(frame, "step")
                else:
                    lines = self.breakpoints.get(self.project_file(frame.f_code))
                    if lines and frame.f_lineno in lines:
                        self.stop(frame, "breakpoint")
            elif event == "return":
                mode = self.mode
                if mode is not None and mode != "pause" and (mode == "in" or frame is self.step_frame):
                    caller = frame.f_back
                    while caller is not None and not self.project_file(caller.f_code):
                        caller = caller.f_back
                    if mode in ("over", "out"):
                        # Leaving the stepped frame: stop at the caller's next line.
                        self.mode, self.step_frame = ("over", caller) if caller is not None else ("in", None)
                    if caller is not None:
                        self.arm(caller)
        except Exception as e:  # noqa: BLE001 - a failing tracer must not kill the program
            self.event("error", message=f"tracer: {type(e).__name__}: {e}")
        return self.trace_local

    # -- stopping

    def frame_name(self, frame):
        code = frame.f_code
        name = getattr(code, "co_qualname", code.co_name)
        return name.replace(".<locals>.", ".")

    def stop(self, frame, reason, description=None, stack=None):
        if stack is None:
            stack = []
            f = frame
            while f is not None:
                if self.project_file(f.f_code):
                    stack.append((f, f.f_lineno))
                f = f.f_back
        with self.state:
            self.paused = True
            self.mode = None
            self.step_frame = None
            self.stack = stack
            self.stop_reason = reason
            self.refs.clear()
            self.next_ref = 1
        frames = [
            {"id": i, "name": self.frame_name(f), "file": self.project_file(f.f_code), "line": line, "localsRef": self.register(("frame", f))}
            for i, (f, line) in enumerate(stack)
        ]
        body = {"reason": reason, "thread": THREAD_NAME, "frames": frames}
        if description:
            body["description"] = description
        self.event("stopped", **body)
        while True:
            req = self.commands.get()
            if self.safe_handle(req, paused=True):
                break
        with self.state:
            self.paused = False
            self.stack = []
            self.refs.clear()
            leftover = []
            while not self.commands.empty():
                leftover.append(self.commands.get_nowait())
        self.event("continued")
        for req in leftover:
            self.safe_handle(req, paused=False)

    # -- variables

    def register(self, target):
        ref = self.next_ref
        self.next_ref += 1
        self.refs[ref] = target
        return ref

    def format(self, v):
        count = expandable_count(v)
        d = {"value": clip(preview(v)), "type": type_name(v), "ref": self.register(("value", v)) if count else 0}
        if base_of(v, SEQUENCES) is not None or isinstance(v, dict):
            d["length"] = count
        return d

    def describe(self, name, v):
        d = self.format(v)
        d["name"] = name
        return d

    @staticmethod
    def module_globals(frame):
        """The module's own names: not dunders or imported modules."""
        return [(k, v) for k, v in dict.items(frame.f_globals)
                if not (k.startswith("__") and k.endswith("__")) and not isinstance(v, types.ModuleType)]

    def variables(self, ref):
        target = self.refs.get(ref)
        if target is None:
            raise RuntimeError("variable reference expired; the program has resumed")
        kind, obj = target
        if kind == "globals":
            items = self.module_globals(obj)
            return [self.describe(k, v) for k, v in items[:MAX_CHILDREN]]
        if kind == "frame":
            if obj.f_code.co_name == "<module>":
                items = self.module_globals(obj)
                return [self.describe(k, v) for k, v in items[:MAX_CHILDREN]]
            out = [self.describe(k, v) for k, v in list(obj.f_locals.items())[:MAX_CHILDREN]]
            count = len(self.module_globals(obj))
            if count:
                out.append({"name": "globals", "value": f"module {obj.f_globals.get('__name__', '?')} ({count})", "type": "",
                            "ref": self.register(("globals", obj))})
            return out
        items, total = children(obj)
        out = [self.describe(k, v) for k, v in items]
        if total > len(items):
            out.append({"name": "…", "value": f"{total - len(items)} more", "type": "", "ref": 0})
        return out

    # -- launch and run

    def pump(self, fd, stream):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            text = decoder.decode(data, final=not data)
            if text:
                self.event("output", stream=stream, text=text)
            if not data:
                break
        os.close(fd)

    def redirect_stdio(self, stdin_path):
        fd = os.open(stdin_path if stdin_path and os.path.exists(stdin_path) else os.devnull, os.O_RDONLY)
        os.dup2(fd, 0)
        os.close(fd)
        for target, stream in ((1, "stdout"), (2, "stderr")):
            r, w = os.pipe()
            os.dup2(w, target)
            os.close(w)
            t = threading.Thread(target=self.pump, args=(r, stream), name=f"cw-{stream}", daemon=True)
            t.start()
            self.pumps.append(t)
        raw = WatchedStdin(0, lambda waiting: self.event("input", waiting=waiting))
        sys.stdin = sys.__stdin__ = io.TextIOWrapper(io.BufferedReader(raw), encoding="utf-8")
        # newline="\n" keeps output identical to the Linux sandbox when tested on other hosts.
        for fd, name in ((1, "stdout"), (2, "stderr")):
            stream = io.TextIOWrapper(io.FileIO(fd, "w", closefd=False), encoding="utf-8", errors="backslashreplace", newline="\n", write_through=True)
            setattr(sys, name, stream)
            setattr(sys, f"__{name}__", stream)

    def launch(self, req):
        self.root = os.path.abspath(req.get("root") or os.getcwd())
        self.files = {str(f) for f in req.get("files") or []}
        for file, lines in (req.get("breakpoints") or {}).items():
            if lines:
                self.breakpoints[file] = {int(n) for n in lines}
        entry = os.path.join(self.root, req["entry"])
        os.chdir(self.root)
        sys.argv = [entry]
        sys.path[0] = os.path.dirname(entry)
        self.redirect_stdio(req.get("stdinPath"))
        for file in self.breakpoints:
            lines = sorted(self.breakpoints[file])
            ok = self.executable_lines(file) if file in self.files else set()
            self.event("breakpoints", file=file, breakpoints=[{"line": n, "verified": n in ok} for n in lines])
        return entry

    def run(self, entry):
        code = 0
        sys.settrace(self.trace_call)
        try:
            runpy.run_path(entry, run_name="__main__")
        except SystemExit as e:
            code = self.exit_code(e)
        except BaseException as e:  # noqa: BLE001 - the program's own uncaught exception
            sys.settrace(None)
            self.uncaught(e)
            code = 1
        finally:
            sys.settrace(None)
        for t in threading.enumerate():
            if t is not threading.current_thread() and not t.daemon:
                t.join()
        try:
            atexit._run_exitfuncs()
        except BaseException:  # noqa: BLE001
            pass
        return code

    @staticmethod
    def exit_code(e):
        if e.code is None:
            return 0
        if isinstance(e.code, int):
            return e.code & 0xFF
        print(e.code, file=sys.stderr)
        return 1

    def uncaught(self, exc):
        entries = []
        tb = exc.__traceback__
        while tb is not None:
            entries.append((tb.tb_frame, tb.tb_lineno))
            tb = tb.tb_next
        stack = [(f, line) for f, line in reversed(entries) if self.project_file(f.f_code)]
        if stack:
            description = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            self.stop(None, "exception", description=description, stack=stack)
        # Print the traceback like a normal run, starting at the program's own frames.
        tb = exc.__traceback__
        while tb is not None and not self.project_file(tb.tb_frame.f_code):
            tb = tb.tb_next
        traceback.print_exception(type(exc), exc, tb, file=sys.stderr)

    def finish(self, code):
        for s in (sys.stdout, sys.stderr):
            try:
                s.flush()
            except Exception:  # noqa: BLE001
                pass
        for fd in (1, 2):
            try:
                os.close(fd)
            except OSError:
                pass
        for t in self.pumps:
            t.join(2)
        self.event("exited", exitCode=code)
        os._exit(0)


def main():
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    commands = os.fdopen(os.dup(0), "r", encoding="utf-8")
    adapter = Adapter(proto)
    launch = None
    for line in commands:
        try:
            req = json.loads(line)
        except ValueError as e:
            adapter.event("error", message=f"invalid request: {e}")
            continue
        if isinstance(req, dict) and req.get("cmd") == "launch":
            launch = req
            break
        adapter.respond(req.get("seq") if isinstance(req, dict) else None, False, "program not launched")
    if launch is None:
        os._exit(0)
    try:
        entry = adapter.launch(launch)
    except Exception as e:  # noqa: BLE001
        adapter.respond(launch.get("seq"), False, f"{type(e).__name__}: {e}")
        os._exit(1)
    threading.Thread(target=adapter.read_commands, args=(commands,), name="cw-commands", daemon=True).start()
    adapter.respond(launch.get("seq"))
    adapter.event("continued")
    adapter.finish(adapter.run(entry))


if __name__ == "__main__":
    main()
