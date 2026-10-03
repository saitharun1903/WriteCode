"""Delve, for the Go debugger and tracer: start it, talk to it, read Go values.

Delve (dlv) runs the program as its child and answers JSON-RPC on a local
socket. This module is shared by cw_dlv_adapter.py (the debugger) and
cw_trace_dlv.py (the visualizer's tracer).
"""

import json
import os
import re
import socket
import subprocess
import threading
import time

ADDRESS = ("127.0.0.1", 40440)

# reflect.Kind, as Delve reports it.
BOOL, INT, INT8, INT16, INT32, INT64, UINT, UINT8, UINT16, UINT32, UINT64, UINTPTR = 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
FLOAT32, FLOAT64, COMPLEX64, COMPLEX128 = 13, 14, 15, 16
ARRAY, CHAN, FUNC, INTERFACE, MAP, PTR, SLICE, STRING, STRUCT, UNSAFE_POINTER = 17, 18, 19, 20, 21, 22, 23, 24, 25, 26
NUMBERS = {INT, INT8, INT16, INT32, INT64, UINT, UINT8, UINT16, UINT32, UINT64, UINTPTR, FLOAT32, FLOAT64, COMPLEX64, COMPLEX128}

# Variable flags.
SHADOWED = 2
RETURN_ARGUMENT = 16


class RPCError(Exception):
    pass


class Client:
    """One connection to Delve. Calls block until Delve answers (`Command continue` until the program stops)."""

    def __init__(self):
        last = None
        for _ in range(400):
            try:
                self.sock = socket.create_connection(ADDRESS)
                break
            except OSError as e:
                last = e
                time.sleep(0.025)
        else:
            raise RPCError(f"Delve did not start: {last}")
        self.file = self.sock.makefile("rwb")
        self.lock = threading.Lock()
        self.next_id = 0

    def call(self, method, **params):
        with self.lock:
            self.next_id += 1
            self.file.write((json.dumps({"method": "RPCServer." + method, "params": [params], "id": self.next_id}) + "\n").encode())
            self.file.flush()
            line = self.file.readline()
        if not line:
            raise RPCError("Delve closed the connection")
        reply = json.loads(line)
        if reply.get("error"):
            raise RPCError(str(reply["error"]))
        return reply.get("result") or {}


def start(program, stdin, out, err):
    """Starts Delve on the compiled program, its stdin and output redirected."""
    return subprocess.Popen(
        ["dlv", "exec", program, "--headless", "--api-version=2", "--accept-multiclient", f"--listen={ADDRESS[0]}:{ADDRESS[1]}",
         "-r", f"stdin:{stdin}", "-r", f"stdout:{out}", "-r", f"stderr:{err}", "--log-dest=/dev/null"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def load_config(depth=1, items=100, strings=500):
    return {"FollowPointers": True, "MaxVariableRecurse": depth, "MaxStringLen": strings, "MaxArrayValues": items, "MaxStructFields": -1}


# ------------------------------------------------------------------ files and names


class Project:
    def __init__(self, root, files):
        self.root = os.path.normpath(root)
        self.files = set(files)

    def file(self, path):
        """The project path of a file Delve names, or None for Go's own code."""
        if not path:
            return None
        full = os.path.normpath(path)
        if not full.startswith(self.root + "/"):
            return None
        rel = full[len(self.root) + 1:]
        return rel if rel in self.files else None


def function_name(name):
    """`main.square` reads `square`; `main.(*Stack).Push` reads `Stack.Push`; a closure, `main.main.func1`, reads `main.func1`."""
    if not name:
        return "??"
    name = re.sub(r"^main\.", "", name)
    name = re.sub(r"\(\*?([A-Za-z_]\w*)\)", r"\1", name)
    return name


_PACKAGE = re.compile(r"\b(?:main|[a-z_][a-z0-9_]*/)*main\.(?=[A-Za-z_])")


def type_name(t):
    """`main.Node` reads `Node`, `*main.Node` reads `*Node`; Go's own packages keep their names (`strings.Builder`)."""
    return _PACKAGE.sub("", t or "")


_sources = {}


def source_line(path, line):
    if path not in _sources:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                _sources[path] = fh.read().split("\n")
        except OSError:
            _sources[path] = []
    lines = _sources[path]
    return lines[line - 1] if 0 < line <= len(lines) else ""


def at_func_line(thread):
    """Stopped on a function's `func` line: a step into it goes on to the first line of its body, as in the other languages."""
    return re.match(r"\s*func\b", source_line(thread.get("file"), thread.get("line", 0))) is not None


# ------------------------------------------------------------------ values


def is_nil(v):
    k = v.get("kind")
    if k in (PTR, UNSAFE_POINTER, CHAN):
        return v.get("value") in ("0", "0x0", "nil")
    if k == FUNC:
        return v.get("value") in ("", "nil")
    if k == INTERFACE:
        return unwrap(v) is None
    if k in (SLICE, MAP):
        return v.get("base", 0) == 0
    return False


def scalar_text(v):
    k = v.get("kind")
    value = v.get("value", "")
    if k == STRING:
        text = value
        if v.get("len", len(text)) > len(text):
            text += "…"
        return json.dumps(text, ensure_ascii=False)
    if k == BOOL:
        return value
    if k == INT32 and v.get("type") == "rune":
        try:
            return repr(chr(int(value)))
        except ValueError:
            return value
    if k == UINT8 and v.get("type") == "byte":
        return value
    return value


def unwrap(v):
    """An interface's value is what it holds."""
    while v.get("kind") == INTERFACE:
        kids = v.get("children") or []
        if not kids or kids[0].get("kind") == 0:
            return None
        v = kids[0]
    return v


BOUNDS = {
    0: "index out of range [{x}] with length {y}",
    1: "slice bounds out of range [:{x}] with length {y}",
    2: "slice bounds out of range [:{x}] with capacity {y}",
    3: "slice bounds out of range [{x}:{y}]",
    4: "slice bounds out of range [::{x}] with length {y}",
    5: "slice bounds out of range [::{x}] with capacity {y}",
    6: "slice bounds out of range [:{x}:{y}]",
    7: "slice bounds out of range [{x}:{y}:]",
    8: "cannot convert slice with length {x} to array or pointer to array with length {y}",
}


def panic_message(arg):
    """What `panic` was given, as Go prints it: `runtime error: index out of range [5] with length 2`, a string, an error's text."""
    v = unwrap(arg) if arg else None
    if v is None:
        return "panic"
    t = v.get("type", "")
    if v.get("kind") == STRING:
        text = v.get("value", "")
        return f"runtime error: {text}" if t.startswith("runtime.") else text
    fields = {c.get("name"): c for c in (v.get("children") or [])}
    if t == "runtime.boundsError" and "code" in fields:
        try:
            return "runtime error: " + BOUNDS[int(fields["code"]["value"])].format(x=fields["x"]["value"], y=fields["y"]["value"])
        except (KeyError, ValueError):
            pass
    if v.get("kind") == PTR and v.get("children"):
        return panic_message(v["children"][0])
    for c in v.get("children") or []:
        if c.get("kind") == STRING:
            return c.get("value", "")
    return scalar_text(v) or "panic"
