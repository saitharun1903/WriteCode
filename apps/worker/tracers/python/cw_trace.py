"""Code Workspace Python execution tracer (visualizer).

Runs the program in this interpreter under sys.settrace and records, for
every line executed in a project file, the call stack with each frame's
variables and every object reachable from them. Writes the trace as JSON when
the program ends. Program stdin, stdout and stderr are untouched apart from
counting stdout characters, so output appears exactly as in a normal run.

    python3 cw_trace.py <config.json>

config: {"entry", "root", "files", "out", "limits": {...}}

Objects are read through built-in slot functions (list.__iter__, dict.items,
instance __dict__), never through user-defined __repr__, properties or
__getattr__, so recording cannot change what the program does.
"""

import collections
import enum
import itertools
import json
import os
import runpy
import sys
import threading
import traceback
import types

SEQUENCES = (list, tuple, set, frozenset, collections.deque)
SCALARS = (bool, int, float, complex, str, bytes)


def base_of(v, bases):
    for b in bases:
        if isinstance(v, b):
            return b
    return None


class Tee:
    """Counts and keeps what the program writes to stdout while passing it through."""

    def __init__(self, stream, keep):
        self._stream = stream
        self.count = 0
        self.kept = []
        self._keep = keep

    def write(self, s):
        n = self._stream.write(s)
        if isinstance(s, str):
            self.count += len(s)
            if self._keep > 0:
                self.kept.append(s[: self._keep])
                self._keep -= len(s)
        return n

    def __getattr__(self, name):
        return getattr(self._stream, name)


class Tracer:
    def __init__(self, config):
        self.root = os.path.abspath(config["root"])
        self.files = set(config["files"])
        self.limits = config["limits"]
        self.steps = []
        self.size = 0
        self.truncated = None
        self.done = False
        self.code_files = {}
        self.stdout = None

    # -- files

    def project_file(self, code):
        try:
            return self.code_files[code]
        except KeyError:
            pass
        path = None
        if not code.co_filename.startswith("<"):
            try:
                rel = os.path.relpath(os.path.abspath(code.co_filename), self.root).replace(os.sep, "/")
            except ValueError:
                rel = None
            if rel in self.files:
                path = rel
        self.code_files[code] = path
        return path

    # -- tracing

    def trace_call(self, frame, event, arg):
        if self.done or event != "call" or self.project_file(frame.f_code) is None:
            return None
        return self.trace_local

    def trace_local(self, frame, event, arg):
        if self.done:
            return None
        try:
            if event == "line":
                self.record(frame, "line")
            elif event == "return":
                self.record(frame, "return", return_value=arg)
            elif event == "exception":
                exc_type, exc, _tb = arg
                self.record(frame, "exception", exception="".join(traceback.format_exception_only(exc_type, exc)).strip())
        except Exception as e:  # noqa: BLE001 - never let recording break the program
            self.stop(f"recording failed: {type(e).__name__}: {e}")
        return self.trace_local

    def stop(self, reason):
        if not self.done:
            self.done = True
            self.truncated = reason
            sys.settrace(None)

    # -- snapshots

    def record(self, frame, event, return_value=None, exception=None):
        if len(self.steps) >= self.limits["maxSteps"]:
            self.stop(f"Recording stopped after {self.limits['maxSteps']} steps; the program continued without recording.")
            return
        stack = []
        f = frame
        while f is not None:
            if self.project_file(f.f_code):
                stack.append(f)
            f = f.f_back
        stack.reverse()

        heap = {}
        encoder = Encoder(heap, self.limits)
        frames = []
        for f in stack:
            code = f.f_code
            name = getattr(code, "co_qualname", code.co_name).replace(".<locals>.", ".")
            if code.co_name == "<module>":
                items = [(k, v) for k, v in dict.items(f.f_globals) if not isinstance(v, types.ModuleType)]
            else:
                items = list(f.f_locals.items())
            # Interpreter bookkeeping such as __module__ in class bodies is not the program's data.
            items = [(k, v) for k, v in items if not (k.startswith("__") and k.endswith("__"))]
            entry = {"name": name, "file": self.project_file(code), "line": f.f_lineno, "locals": [[k, encoder.value(v)] for k, v in items]}
            if f is frame and event == "return":
                entry["returnValue"] = encoder.value(return_value)
            frames.append(entry)
        encoder.drain()

        step = {"event": event, "frames": frames, "heap": heap, "stdoutLength": self.stdout.count if self.stdout else 0}
        if exception:
            step["exception"] = exception
        text = json.dumps(step, ensure_ascii=False, separators=(",", ":"))
        self.size += len(text) + 1
        if self.size > self.limits["maxTraceBytes"]:
            self.stop("Recording stopped because the trace grew too large; the program continued without recording.")
            return
        self.steps.append(text)

    def write(self, path):
        stdout = "".join(self.stdout.kept) if self.stdout else ""
        head = {"language": "python", "stdout": stdout}
        if self.truncated:
            head["truncated"] = self.truncated
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(head, ensure_ascii=False)[:-1])
            f.write(',"steps":[')
            f.write(",".join(self.steps))
            f.write("]}")


class Encoder:
    """Turns values into trace values, adding reachable objects to the step's heap breadth-first."""

    def __init__(self, heap, limits):
        self.heap = heap
        self.limits = limits
        self.queue = []

    def value(self, v):
        if v is None:
            return {"kind": "value", "text": "None", "type": "NoneType"}
        if isinstance(v, enum.Enum):
            return {"kind": "value", "text": f"{type(v).__qualname__}.{v._name_}", "type": type(v).__qualname__}
        base = base_of(v, SCALARS)
        if base is not None:
            return {"kind": "value", "text": self.scalar(v, base), "type": base.__name__}
        oid = str(id(v))
        if oid not in self.heap:
            if len(self.heap) >= self.limits["maxObjectsPerStep"]:
                return {"kind": "value", "text": f"<{type(v).__qualname__}>", "type": type(v).__qualname__}
            self.heap[oid] = None  # reserved; filled by drain()
            self.queue.append((oid, v))
        return {"kind": "ref", "id": oid}

    def scalar(self, v, base):
        try:
            if base is str:
                s = str.__str__(v)
                n = self.limits["maxStringChars"]
                return repr(s) if len(s) <= n else repr(s[:n]) + "…"
            if base is bytes:
                b = bytes(v)
                return repr(b[:100]) + ("…" if len(b) > 100 else "")
            if base is bool:
                return "True" if v else "False"
            return base.__repr__(v)
        except ValueError:
            return f"<int with {int.bit_length(v)} bits>"

    def drain(self):
        while self.queue:
            oid, v = self.queue.pop(0)
            self.heap[oid] = self.describe(v)
        # Objects dropped for size were never reserved, so nothing is left as None.

    def describe(self, v):
        cap = self.limits["maxItemsPerObject"]
        t = type(v)
        if isinstance(v, dict):
            pairs = list(itertools.islice(dict.items(v), cap))
            return self.trim({"kind": "map", "type": t.__qualname__, "entries": [[self.value(k), self.value(x)] for k, x in pairs]}, dict.__len__(v), len(pairs))
        base = base_of(v, SEQUENCES)
        if base is not None:
            items = list(itertools.islice(base.__iter__(v), cap))
            return self.trim({"kind": "sequence", "type": t.__qualname__, "items": [self.value(x) for x in items]}, base.__len__(v), len(items))
        if isinstance(v, range):
            return {"kind": "other", "type": "range", "text": range.__repr__(v)}
        if isinstance(v, (types.FunctionType, types.BuiltinFunctionType)):
            return {"kind": "other", "type": "function", "text": self.signature(v)}
        if isinstance(v, types.MethodType):
            return {"kind": "other", "type": "method", "text": f"bound method {getattr(v.__func__, '__qualname__', '?')}"}
        if isinstance(v, type):
            return {"kind": "other", "type": "class", "text": f"class {v.__qualname__}"}
        if isinstance(v, BaseException):
            fields = [("args", self.value(BaseException.__getattribute__(v, "args")))]
            return {"kind": "object", "type": t.__qualname__, "fields": [[k, x] for k, x in fields]}
        fields = instance_fields(v)
        if fields or has_instance_dict(v):
            shown = fields[:cap]
            return self.trim({"kind": "object", "type": t.__qualname__, "fields": [[k, self.value(x)] for k, x in shown]}, len(fields), len(shown))
        return {"kind": "other", "type": t.__qualname__, "text": f"{t.__qualname__} object"}

    @staticmethod
    def trim(obj, total, shown):
        if total > shown:
            obj["omitted"] = total - shown
        return obj

    @staticmethod
    def signature(fn):
        code = getattr(fn, "__code__", None)
        name = getattr(fn, "__qualname__", getattr(fn, "__name__", "?"))
        if code is None:
            return f"built-in {name}"
        params = list(code.co_varnames[: code.co_argcount + code.co_kwonlyargcount])
        if code.co_flags & 0x04:
            params.append("*" + code.co_varnames[len(params)])
        return f"{name}({', '.join(params)})"


def has_instance_dict(v):
    try:
        return type(object.__getattribute__(v, "__dict__")) is dict
    except (AttributeError, TypeError):
        return False


def instance_fields(v):
    """Instance attributes from __dict__ and __slots__, without invoking __getattr__ or properties."""
    fields = []
    try:
        d = object.__getattribute__(v, "__dict__")
    except (AttributeError, TypeError):
        d = None
    if type(d) is dict:
        fields.extend((k, x) for k, x in dict.items(d) if type(k) is str)
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


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        config = json.load(f)
    tracer = Tracer(config)
    entry = os.path.join(tracer.root, config["entry"])
    os.chdir(tracer.root)
    sys.argv = [entry]
    sys.path[0] = os.path.dirname(entry)
    tracer.stdout = Tee(sys.stdout, keep=1_000_000)
    sys.stdout = tracer.stdout

    code = 0
    sys.settrace(tracer.trace_call)
    try:
        runpy.run_path(entry, run_name="__main__")
    except SystemExit as e:
        if e.code is None:
            code = 0
        elif isinstance(e.code, int):
            code = e.code & 0xFF
        else:
            print(e.code, file=sys.stderr)
            code = 1
    except BaseException as e:  # noqa: BLE001 - the program's own uncaught exception
        sys.settrace(None)
        tb = e.__traceback__
        while tb is not None and not tracer.project_file(tb.tb_frame.f_code):
            tb = tb.tb_next
        traceback.print_exception(type(e), e, tb, file=sys.stderr)
        code = 1
    finally:
        sys.settrace(None)
    for t in threading.enumerate():
        if t is not threading.current_thread() and not t.daemon:
            t.join()
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    tracer.write(config["out"])
    sys.stdout = sys.__stdout__
    sys.exit(code)


if __name__ == "__main__":
    main()
