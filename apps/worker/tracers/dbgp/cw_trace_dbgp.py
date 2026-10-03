"""Code Workspace PHP tracer (visualizer), driving Xdebug.

    python3 cw_trace_dbgp.py <config.json>

Runs the program under Xdebug and steps through every line of the
program's own files, recording the call stack with each frame's variables and
the arrays and objects they hold. Writes the trace as JSON, the same format as
the other tracers.

The program reads its stdin directly (the input file or the typed-input
FIFO); its stdout and stderr pass through this script, which counts what was
printed before each step and copies it out unchanged.
"""

import json
import os
import re
import sys
import time

CONFIG = json.load(open(sys.argv[1], encoding="utf-8"))
sys.path.insert(0, os.path.dirname(os.path.abspath(CONFIG.get("module", "/tmp/cwviz/cw_dbgp.py"))))
import cw_dbgp as dbgp  # noqa: E402

LIMITS = CONFIG["limits"]
PROJECT = dbgp.Project(CONFIG["root"], CONFIG["files"])
OUT_FIFO = "/tmp/cw-trace-out"
ERR_FIFO = "/tmp/cw-trace-err"
BUDGET_S = 14.0


class Relay:
    """Copies the program's output out as it comes, counting characters printed so far."""

    def __init__(self):
        import codecs

        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.fds = []
        self.printed = 0
        self.text = []

    def open(self):
        for path, target in ((OUT_FIFO, 1), (ERR_FIFO, 2)):
            if not os.path.exists(path):
                os.mkfifo(path)
            self.fds.append((os.open(path, os.O_RDWR | os.O_NONBLOCK), target))

    def drain(self):
        for fd, target in self.fds:
            while True:
                try:
                    data = os.read(fd, 65536)
                except (BlockingIOError, OSError):
                    break
                if not data:
                    break
                os.write(target, data)
                if target == 1:
                    text = self.decoder.decode(data)
                    self.text.append(text)
                    self.printed += len(text)


relay = Relay()


def quote(fullname):
    return '"' + fullname.replace("\\", "\\\\").replace('"', '\\"') + '"'


class Snapshot:
    """Arrays and objects reachable from the frames at one step. Objects are told apart by spl_object_id where it can be read."""

    def __init__(self, session):
        self.session = session
        self.heap = {}
        self.ids = {}

    def full(self):
        return len(self.heap) >= LIMITS["maxObjectsPerStep"]

    def register(self, oid, make):
        if oid in self.heap:
            return {"kind": "ref", "id": oid}
        if self.full():
            return None
        self.heap[oid] = {"kind": "other", "type": "", "text": "…"}  # placeholder against cycles
        self.heap[oid] = make()
        return {"kind": "ref", "id": oid}

    def loaded(self, p, level):
        """`p` with its children: Xdebug sends a few levels at a time; deeper ones are read now."""
        if dbgp.children(p) or not int(p.get("numchildren") or 0) or not p.get("fullname"):
            return p
        try:
            got = self.session.call(f"property_get -d {level} -n {quote(p.get('fullname'))}").find(dbgp.NS + "property")
            return got if got is not None else p
        except dbgp.DBGpError:
            return p

    def value(self, p, level):
        text = dbgp.scalar(p)
        t = p.get("type")
        if text is not None:
            return {"kind": "value", "text": text, "type": t}
        fullname = p.get("fullname") or f"?{id(p)}"
        if t == "array":
            return self.register(f"a{level}:{fullname}", lambda: self.array(p, level)) or {"kind": "value", "text": "[…]", "type": "array"}
        if t == "object":
            cls = p.get("classname") or "object"
            known = self.ids.get(fullname)
            oid = f"o{known}" if known is not None else f"o{level}:{fullname}"
            return self.register(oid, lambda: self.object(p, level, cls)) or {"kind": "value", "text": f"{cls} {{…}}", "type": cls}
        return {"kind": "value", "text": dbgp.text_of(p) or t or "?", "type": t or "?"}

    def array(self, p, level):
        p = self.loaded(p, level)
        kids = dbgp.children(p)
        total = int(p.get("numchildren") or len(kids))
        if dbgp.is_list(p):
            o = {"kind": "sequence", "type": "array", "items": [self.value(k, level) for k in kids]}
            shown = len(o["items"])
        else:
            o = {"kind": "map", "type": "array", "entries": [[{"kind": "value", "text": dbgp.key_text(k), "type": "key"}, self.value(k, level)] for k in kids]}
            shown = len(o["entries"])
        if total > shown:
            o["omitted"] = total - shown
        return o

    def object(self, p, level, cls):
        p = self.loaded(p, level)
        kids = dbgp.children(p)
        o = {"kind": "object", "type": cls, "fields": [[dbgp.name_of(k), self.value(k, level)] for k in kids]}
        total = int(p.get("numchildren") or len(kids))
        if total > len(kids):
            o["omitted"] = total - len(kids)
        return o

    def read_ids(self, properties):
        """spl_object_id of every object the innermost frame reaches, read in one evaluation."""
        paths = []

        def walk(p):
            if p.get("type") == "object" and p.get("fullname"):
                paths.append(p.get("fullname"))
            for k in dbgp.children(p):
                walk(k)

        for p in properties:
            walk(p)
        paths = paths[: LIMITS["maxObjectsPerStep"]]
        if not paths:
            return
        code = "json_encode(array_map(function ($f) { try { return spl_object_id($f()); } catch (\\Throwable $e) { return null; } }, [" + ", ".join(f"fn() => {p}" for p in paths) + "]))"
        try:
            reply = self.session.call("eval", code)
            got = json.loads(dbgp.text_of(reply.find(dbgp.NS + "property")))
            self.ids = {path: i for path, i in zip(paths, got) if i is not None}
        except (dbgp.DBGpError, ValueError, TypeError, AttributeError):
            self.ids = {}


# The order each frame's variables were first seen in: Xdebug lists them alphabetically, the program writes them in its own order.
first_seen = {}


def in_order(name, local):
    seen = first_seen.setdefault(name, {})
    for n, _ in local:
        seen.setdefault(n, len(seen))
    return sorted(local, key=lambda kv: seen[kv[0]])


def snapshot(session, event, exception=None):
    try:
        stack = [s for s in session.call("stack_get") if s.tag == dbgp.NS + "stack"]
    except dbgp.DBGpError:
        return None
    frames = [s for s in stack if PROJECT.file(s.get("filename"))]
    if not frames:
        return None
    snap = Snapshot(session)
    out = []
    contexts = {}
    for s in frames:
        level = int(s.get("level") or 0)
        try:
            contexts[level] = [p for p in session.call(f"context_get -d {level} -c 0") if p.tag == dbgp.NS + "property"]
        except dbgp.DBGpError:
            contexts[level] = []
    top = int(frames[0].get("level") or 0)
    snap.read_ids(contexts.get(top, []))
    for s in reversed(frames):
        level = int(s.get("level") or 0)
        name = dbgp.frame_name(s.get("where"))
        local = [[dbgp.name_of(p), snap.value(p, level)] for p in contexts[level] if p.get("type") != "uninitialized"]
        out.append({"name": name, "file": PROJECT.file(s.get("filename")), "line": int(s.get("lineno") or 0), "locals": in_order(name, local)})
    relay.drain()
    step = {"event": event, "frames": out, "heap": snap.heap, "stdoutLength": relay.printed}
    if exception:
        step["exception"] = exception
    return step


CALL = re.compile(r"[A-Za-z_\\]\w*\s*\(")
_sources = {}


def source_line(file, line):
    if file not in _sources:
        try:
            with open(os.path.join(PROJECT.root, file), encoding="utf-8", errors="replace") as fh:
                _sources[file] = fh.read().split("\n")
        except OSError:
            _sources[file] = []
    lines = _sources[file]
    return lines[line - 1] if 0 < line <= len(lines) else ""


def returned_expression(file, line):
    """The expression of a `return x;` that calls nothing (reading it runs none of the program's code), or None."""
    code = source_line(file, line)
    m = re.match(r"\s*return\s+(.+?);\s*(//.*|#.*)?$", code)
    if not m:
        return None
    expr = m.group(1)
    bare = re.sub(r"'(\\.|[^'])*'|\"(\\.|[^\"])*\"", "", expr)
    if CALL.search(bare) or re.search(r"\bnew\b|\+\+|--|(?<![=!<>])=(?![=>])", bare):
        return None
    return expr


def main():
    relay.open()
    stdin = CONFIG.get("stdin")
    stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
    os.chdir(PROJECT.root)
    steps = []
    truncated = None
    exit_code = 0
    session = None

    def add(step):
        if step is None:
            return
        if steps and json.dumps(steps[-1], sort_keys=True) == json.dumps(step, sort_keys=True):
            return
        steps.append(step)

    try:
        session = dbgp.Session(CONFIG["entry"], stdin, OUT_FIFO, ERR_FIFO)
        for name, value in (("max_depth", "4"), ("max_children", str(LIMITS["maxItemsPerObject"])), ("max_data", str(LIMITS["maxStringChars"]))):
            session.call(f"feature_set -n {name} -v {value}")
        # An exception stops where it is thrown (Exception and Error cover every class PHP throws); a warning does not.
        for name in ("Exception", "Error"):
            session.call(f'breakpoint_set -t exception -x "{name}"')
        started = time.monotonic()
        tracing = True
        command = "step_into"
        while True:
            relay.drain()
            try:
                reply = session.call(command)
            except EOFError:
                reply = None
            if reply is None or reply.get("status") in ("stopping", "stopped"):
                # The script has no return of its own: its end is a step, so what its last line printed is in the trace.
                if tracing and steps and len(steps[-1]["frames"]) == 1:
                    time.sleep(0.02)
                    relay.drain()
                    end = json.loads(json.dumps(steps[-1]))
                    end["event"] = "return"
                    end["stdoutLength"] = relay.printed
                    steps.append(end)
                break
            uri, line, exception, message = dbgp.message_of(reply)
            if exception:
                # Thrown: recorded where it was thrown. A catch goes on from there; an uncaught one ends the program.
                if tracing:
                    add(snapshot(session, "exception", exception=f"{exception}: {message}" if message else exception))
                command = "step_into" if tracing else "run"
                continue
            if not tracing:
                command = "run"
                continue
            file = PROJECT.file(uri)
            if file is None:
                command = "step_out"
                continue
            add(snapshot(session, "line"))
            if len(steps) >= LIMITS["maxSteps"]:
                truncated = f"Recording stopped after {LIMITS['maxSteps']} steps; the program continued without recording."
                tracing = False
                command = "run"
                continue
            if time.monotonic() - started > BUDGET_S:
                truncated = "Recording stopped because the program ran for a long time; it continued without recording."
                tracing = False
                command = "run"
                continue
            expr = returned_expression(file, line)
            if expr is not None and steps and len(steps[-1]["frames"]) > 1:
                # The function returns on this line: what it returns, before it does.
                try:
                    got = session.call("eval", f"({expr})").find(dbgp.NS + "property")
                    if got is not None:
                        ret = json.loads(json.dumps(steps[-1]))
                        ret["event"] = "return"
                        snap = Snapshot(session)
                        ret["frames"][-1]["returnValue"] = snap.value(got, -1)
                        ret["heap"].update({k: v for k, v in snap.heap.items() if k not in ret["heap"]})
                        steps.append(ret)
                except dbgp.DBGpError:
                    pass
            command = "step_into"
    except Exception as e:  # noqa: BLE001 - never leave the run without a trace or an explanation
        truncated = f"Recording stopped: {type(e).__name__}: {e}"
    if session is not None:
        try:
            session.conn.close()
        except OSError:
            pass
        try:
            exit_code = session.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            session.proc.kill()
            exit_code = 1
    time.sleep(0.05)
    relay.drain()
    trace = {"language": "php", "steps": steps, "stdout": "".join(relay.text)}
    if truncated:
        trace["truncated"] = truncated
    text = json.dumps(trace, ensure_ascii=False)
    while len(text) > LIMITS["maxTraceBytes"] and len(trace["steps"]) > 1:
        trace["steps"] = trace["steps"][: int(len(trace["steps"]) * 0.8)]
        trace["truncated"] = "The recording was too large; the last steps were dropped."
        text = json.dumps(trace, ensure_ascii=False)
    with open(CONFIG["out"], "w", encoding="utf-8") as fh:
        fh.write(text)
    sys.exit(int(exit_code or 0) & 0xFF)


main()
