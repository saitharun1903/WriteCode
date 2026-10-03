"""netcoredbg, for the C# debugger and tracer: start it, talk DAP to it, read C# values.

netcoredbg (Samsung's open-source .NET debugger) runs the program and answers
the Debug Adapter Protocol on a local port. The program is started through
/bin/sh so that it gets its own stdin and its output goes to our FIFOs:
netcoredbg would otherwise keep both. This module is shared by
cw_netcoredbg_adapter.py (the debugger) and cw_trace_netcoredbg.py (the
visualizer's tracer).

.NET's collections are read through their fields, as a debugger without
.NET's debugger proxies sees them (`_items` and `_size` of a List); they are
shown here as their elements: a List as its items, a Dictionary as its key
and value pairs, a Queue from its head, a LinkedList from its first node.
"""

import json
import os
import queue
import re
import socket
import subprocess
import threading
import time

PORT = 4711


class DAPError(Exception):
    pass


class Client:
    """A DAP connection. Requests can come from several threads; events are queued."""

    def __init__(self):
        last = None
        for _ in range(400):
            try:
                self.sock = socket.create_connection(("127.0.0.1", PORT))
                break
            except OSError as e:
                last = e
                time.sleep(0.025)
        else:
            raise DAPError(f"netcoredbg did not start: {last}")
        self.file = self.sock.makefile("rwb")
        self.write_lock = threading.Lock()
        self.seq = 0
        self.pending = {}
        self.events = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                headers = {}
                while True:
                    line = self.file.readline()
                    if not line:
                        raise EOFError
                    line = line.decode().strip()
                    if not line:
                        break
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()
                msg = json.loads(self.file.read(int(headers["content-length"])))
                if msg.get("type") == "response":
                    slot = self.pending.pop(msg.get("request_seq"), None)
                    if slot is not None:
                        slot.put(msg)
                elif msg.get("type") == "event":
                    self.events.put(msg)
        except (EOFError, OSError, ValueError):
            self.events.put({"type": "event", "event": "terminated", "body": {}})
            for slot in list(self.pending.values()):
                slot.put({"success": False, "message": "netcoredbg ended"})

    def request(self, command, timeout=60, **args):
        slot = queue.Queue()
        with self.write_lock:
            self.seq += 1
            seq = self.seq
            self.pending[seq] = slot
            body = json.dumps({"seq": seq, "type": "request", "command": command, "arguments": args}).encode()
            self.file.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
            self.file.flush()
        try:
            reply = slot.get(timeout=timeout)
        except queue.Empty:
            raise DAPError(f"{command}: no answer") from None
        if not reply.get("success"):
            raise DAPError(reply.get("message") or f"{command} failed")
        return reply.get("body") or {}

    def event(self, names, timeout=None):
        """The next event with one of these names; others are dropped."""
        while True:
            e = self.events.get(timeout=timeout)
            if e.get("event") in names:
                return e


def start(dll, stdin, out, err, stop_at_entry=False):
    """Starts netcoredbg, then the program under it, its stdin and output redirected; returns (process, client)."""
    proc = subprocess.Popen(["/opt/netcoredbg/netcoredbg", "--interpreter=vscode", f"--server={PORT}"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = Client()
    client.request("initialize", adapterID="coreclr", linesStartAt1=True, columnsStartAt1=True, pathFormat="path")
    command = f"exec dotnet {shell(dll)} < {shell(stdin)} > {shell(out)} 2> {shell(err)}"
    client.request("launch", program="/bin/sh", args=["-c", command], cwd=os.getcwd(), justMyCode=True, enableStepFiltering=True, stopAtEntry=stop_at_entry)
    return proc, client


def shell(s):
    return "'" + s.replace("'", "'\\''") + "'"


class Project:
    def __init__(self, root, files):
        self.root = os.path.normpath(root)
        self.files = set(files)

    def file(self, path):
        if not path:
            return None
        full = os.path.normpath(path)
        if not full.startswith(self.root + "/"):
            return None
        rel = full[len(self.root) + 1:]
        return rel if rel in self.files else None


def frame_name(name):
    """`Program.Main()` reads `Program.Main`; a constructor, `Node..ctor()`, reads `Node.Node`; generic arguments are left out."""
    name = re.sub(r"\(.*\)$", "", name or "??")
    name = re.sub(r"<[^<>]*>", "", name)
    m = re.match(r"(.*?)([A-Za-z_]\w*)\.\.c?ctor$", name)
    if m:
        return f"{m.group(1)}{m.group(2)}.{m.group(2)}"
    return name


_NAMESPACE = re.compile(r"\b(?:[A-Za-z_]\w*\.)+(?=[A-Z_a-z]\w*)")


def type_name(t):
    """`System.Collections.Generic.List<int>` reads `List<int>`."""
    return _NAMESPACE.sub("", t or "")


# ------------------------------------------------------------------ values

SCALARS = {"int", "long", "short", "byte", "sbyte", "uint", "ulong", "ushort", "float", "double", "decimal", "bool", "char", "string", "nint", "nuint"}


def is_null(v):
    return v.get("value") == "null"


def scalar_text(v):
    """The value of a number, bool, char or string as C# writes it; None for an object."""
    t = v.get("type") or ""
    value = v.get("value", "")
    if v.get("variablesReference") and t != "string":
        return None
    if t == "char":
        m = re.match(r"\d+\s+('.*')$", value)
        return m.group(1) if m else value
    return value


def kind_of(t):
    """How a type is drawn: `list`, `map`, `set`, `queue`, `stack`, `linkedlist`, `array`, or `object`."""
    t = type_name(t)
    if re.search(r"\[[,\s]*\]$", t):
        return "array"
    base = re.sub(r"<.*$", "", t)
    return {"List": "list", "Dictionary": "map", "SortedDictionary": "map", "HashSet": "set", "SortedSet": "set", "Queue": "queue", "Stack": "stack", "LinkedList": "linkedlist"}.get(base, "object")


def own_fields(kids):
    """A C# object's data, as written: an auto-property by its name (not its hidden backing field), without explicit interface members."""
    return [k for k in kids if not re.fullmatch(r"<\w+>k__BackingField", k.get("name") or "") and "." not in (k.get("name") or "") and not (k.get("name") or "").startswith("<")]


class Reader:
    """Reads values for one stop: children by reference (each read once), and collections as their elements."""

    def __init__(self, client):
        self.client = client
        self.cache = {}

    def kids(self, ref):
        if not ref:
            return []
        if ref not in self.cache:
            try:
                self.cache[ref] = self.client.request("variables", variablesReference=ref).get("variables") or []
            except DAPError:
                self.cache[ref] = []
        return self.cache[ref]

    def field(self, v, name):
        for k in self.kids(v.get("variablesReference")):
            if k.get("name") == name:
                return k
        return None

    @staticmethod
    def number(v, default=0):
        try:
            return int((v or {}).get("value", default))
        except (TypeError, ValueError):
            return default

    def elements(self, v, limit):
        """(kind, items, total): items are values, or (key, value) pairs for a map; None when `v` is not a collection."""
        kind = kind_of(v.get("type"))
        if kind == "object" or is_null(v):
            return None
        if kind == "array":
            kids = [k for k in self.kids(v.get("variablesReference")) if (k.get("name") or "").startswith("[")]
            m = re.search(r"\[(\d+)\]\}?$", v.get("value") or "")
            return "array", kids[:limit], int(m.group(1)) if m else len(kids)
        if kind in ("list", "stack", "queue"):
            array = self.field(v, "_items" if kind == "list" else "_array")
            size = self.number(self.field(v, "_size"))
            slots = [k for k in self.kids((array or {}).get("variablesReference")) if (k.get("name") or "").startswith("[")]
            if kind == "queue" and slots:
                head = self.number(self.field(v, "_head"))
                items = [slots[(head + i) % len(slots)] for i in range(min(size, limit, len(slots)))]
            else:
                items = slots[: min(size, limit)]
            return kind, items, size
        if kind in ("map", "set"):
            entries = self.field(v, "_entries")
            count = self.number(self.field(v, "_count"))
            out = []
            for e in [k for k in self.kids((entries or {}).get("variablesReference")) if (k.get("name") or "").startswith("[")][:count]:
                if len(out) >= limit:
                    break
                parts = {k.get("name"): k for k in self.kids(e.get("variablesReference"))}
                nxt = self.number(parts.get("next") or parts.get("Next"), 0)
                if nxt < -1:
                    continue  # a removed entry
                out.append((parts.get("key"), parts.get("value")) if kind == "map" else parts.get("Value"))
            out = [x for x in out if x is not None and (kind == "set" or (x[0] is not None and x[1] is not None))]
            return kind, out, max(count, len(out))
        if kind == "linkedlist":
            count = self.number(self.field(v, "count"))
            node = self.field(v, "head")
            items = []
            while node is not None and not is_null(node) and len(items) < min(count, limit):
                item = self.field(node, "item")
                if item is not None:
                    items.append(item)
                node = self.field(node, "next")
            return kind, items, count
        return None


def exception_text(info):
    """`ArgumentOutOfRangeException: Index was out of range...`, from netcoredbg's description of where it was thrown."""
    description = info.get("description") or ""
    m = re.search(r"'([\w.`]+)'.*?:\s*'(.*)'\s*$", description, re.S)
    if m:
        return f"{type_name(m.group(1))}: {m.group(2)}"
    return type_name(info.get("exceptionId") or "") or description or "exception"


_sources = {}


def source_lines(path):
    if path not in _sources:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                _sources[path] = fh.read().split("\n")
        except OSError:
            _sources[path] = []
    return _sources[path]


METHOD = re.compile(r"^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|sealed|unsafe|extern|new)\s+)*[\w<>\[\],.?]+\s+\w+\s*(?:<[^>]*>)?\s*\(")


def declared(path, line, names):
    """The locals whose declaration has run by `line`: C# gives a method all its locals from the start, the program writes them further down."""
    lines = source_lines(path)
    if not lines or line < 1:
        return set(names)
    start = 0
    for i in range(min(line, len(lines)) - 1, -1, -1):
        if METHOD.match(lines[i]) and not re.match(r"\s*(?:if|for|foreach|while|switch|return|using|lock|catch)\b", lines[i]):
            start = i
            break
    out = set()
    for name in names:
        decl = re.compile(r"(?:\bvar|[\w>\]?])\s+" + re.escape(name) + r"\s*(?:=|;|,|\)|\bin\b)")
        before = any(decl.search(l) for l in lines[start: line - 1])
        after = any(decl.search(l) for l in lines[line - 1:])
        # Declared on the current line inside a loop header (foreach (var n in ...)) counts as declared.
        here = re.search(r"\b(?:foreach|for)\s*\(", lines[line - 1] if line - 1 < len(lines) else "") and decl.search(lines[line - 1])
        if before or here or not after:
            out.add(name)
    return out
