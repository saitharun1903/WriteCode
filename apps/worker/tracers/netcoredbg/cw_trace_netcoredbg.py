"""Code Workspace C# tracer (visualizer), driving netcoredbg.

    python3 cw_trace_netcoredbg.py <config.json>

Runs the compiled program under netcoredbg from its entry point, then steps
through every line of the program's own code (Just My Code), recording the
call stack with each frame's variables and the objects they reach: the
program's own objects by their fields, and .NET's collections as their
elements. Objects are told apart by their identity hash (the GetHashCode a
class does not override). Writes the trace as JSON, the same format as the
other tracers.

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
sys.path.insert(0, os.path.dirname(os.path.abspath(CONFIG.get("module", "/tmp/cwviz/cw_netcoredbg.py"))))
import cw_netcoredbg as cs  # noqa: E402

LIMITS = CONFIG["limits"]
PROJECT = cs.Project(CONFIG["root"], CONFIG["files"])
OUT_FIFO = "/tmp/cw-trace-out"
ERR_FIFO = "/tmp/cw-trace-err"
BUDGET_S = 14.0
DEPTH = 6


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


class Snapshot:
    """Objects reachable from the frames at one step, by identity where it can be read."""

    def __init__(self, client, frame_id):
        self.client = client
        self.reader = cs.Reader(client)
        self.frame_id = frame_id
        self.heap = {}

    def full(self):
        return len(self.heap) >= LIMITS["maxObjectsPerStep"]

    def identity(self, v):
        """The identity hash of a reference (the GetHashCode a class does not override); None when it cannot be read."""
        expr = v.get("evaluateName")
        if not expr:
            return None
        try:
            return self.client.request("evaluate", expression=f"{expr}.GetHashCode()", frameId=self.frame_id, context="watch").get("result")
        except cs.DAPError:
            return None

    def register(self, oid, make):
        if oid in self.heap:
            return {"kind": "ref", "id": oid}
        if self.full():
            return None
        self.heap[oid] = {"kind": "other", "type": "", "text": "…"}  # placeholder against cycles
        self.heap[oid] = make()
        return {"kind": "ref", "id": oid}

    def value(self, v, depth=0):
        tname = cs.type_name(v.get("type"))
        if cs.is_null(v):
            return {"kind": "value", "text": "null", "type": tname}
        text = cs.scalar_text(v)
        if text is not None:
            if v.get("type") == "string" and len(text) > LIMITS["maxStringChars"] + 2:
                text = text[: LIMITS["maxStringChars"] + 1] + '…"'
            return {"kind": "value", "text": text, "type": tname}
        if depth > DEPTH:
            return {"kind": "value", "text": f"{tname} {{…}}", "type": tname}
        known = self.identity(v)
        oid = f"{known}:{tname}" if known else f"{v.get('evaluateName') or id(v)}:{tname}"
        return self.register(oid, lambda: self.describe(v, tname, depth)) or {"kind": "value", "text": f"{tname} {{…}}", "type": tname}

    def describe(self, v, tname, depth):
        cap = LIMITS["maxItemsPerObject"]
        shape = self.reader.elements(v, cap)
        if shape is not None:
            kind, items, total = shape
            if kind == "map":
                o = {"kind": "map", "type": tname, "entries": [[self.value(k, depth + 1), self.value(x, depth + 1)] for k, x in items]}
                shown = len(o["entries"])
            else:
                o = {"kind": "sequence", "type": tname, "items": [self.value(x, depth + 1) for x in items]}
                shown = len(o["items"])
            if total > shown:
                o["omitted"] = total - shown
            return o
        fields = cs.own_fields(self.reader.kids(v.get("variablesReference")))
        o = {"kind": "object", "type": tname, "fields": [[k.get("name", "?"), self.value(k, depth + 1)] for k in fields[:cap]]}
        if len(fields) > cap:
            o["omitted"] = len(fields) - cap
        return o


def project_frames(client, thread):
    try:
        frames = client.request("stackTrace", threadId=thread, levels=100).get("stackFrames") or []
    except cs.DAPError:
        return []
    return [f for f in frames if PROJECT.file((f.get("source") or {}).get("path"))]


def snapshot(client, thread, event, exception=None):
    frames = project_frames(client, thread)
    if not frames:
        return None
    out = []
    heap = {}
    for f in reversed(frames):
        snap = Snapshot(client, f.get("id"))
        snap.heap = heap
        try:
            scopes = client.request("scopes", frameId=f.get("id")).get("scopes") or []
        except cs.DAPError:
            scopes = []
        kids = snap.reader.kids(scopes[0].get("variablesReference")) if scopes else []
        path = (f.get("source") or {}).get("path")
        shown = cs.declared(path, f.get("line", 0), [k.get("name") for k in kids])
        local = [[k.get("name"), snap.value(k)] for k in kids if k.get("name") in shown and not (k.get("name") or "").startswith("$")]
        out.append({"name": cs.frame_name(f.get("name")), "file": PROJECT.file(path), "line": f.get("line", 0), "locals": local})
    relay.drain()
    step = {"event": event, "frames": out, "heap": heap, "stdoutLength": relay.printed}
    if exception:
        step["exception"] = exception
    return step


CALL = re.compile(r"[A-Za-z_]\w*\s*\(")


def returned_expression(path, line):
    """The expression of a `return x;` that calls nothing (reading it runs none of the program's code), or None."""
    lines = cs.source_lines(path)
    code = lines[line - 1] if 0 < line <= len(lines) else ""
    m = re.match(r"\s*return\s+(.+?);\s*(//.*)?$", code)
    if not m:
        return None
    bare = re.sub(r"'(\\.|[^'\\])*'|\"(\\.|[^\"\\])*\"", "", m.group(1))
    if CALL.search(bare) or re.search(r"\bnew\b|\+\+|--|(?<![=!<>])=(?![=>])", bare):
        return None
    return m.group(1)


def main():
    relay.open()
    stdin = CONFIG.get("stdin")
    stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
    os.chdir(PROJECT.root)
    steps = []
    truncated = None
    exit_code = 0
    proc = None

    def add(step):
        if step is None:
            return
        last = steps[-1] if steps else None
        if last is not None and step["event"] == "line" and last["event"] == "line" and [(f["name"], f["line"]) for f in last["frames"]] == [(f["name"], f["line"]) for f in step["frames"]]:
            # C# stops on one line more than once (a foreach line, a constructor): one step, as it is after the last of them.
            steps[-1] = step
            return
        steps.append(step)

    try:
        proc, client = cs.start(os.path.join(PROJECT.root, CONFIG.get("program", "out/main.dll")), stdin, OUT_FIFO, ERR_FIFO, stop_at_entry=True)
        client.request("setExceptionBreakpoints", filters=["all"])
        client.request("configurationDone")
        started = time.monotonic()
        tracing = True
        thread = None
        last_exception = None
        while True:
            e = client.event(("stopped", "exited", "terminated"))
            name = e.get("event")
            body = e.get("body") or {}
            if name == "exited":
                exit_code = body.get("exitCode", 0)
                continue
            if name == "terminated":
                # The end of Main is a brace, not a step: the end of the program is one, so what its last line printed is in the trace.
                if tracing and steps and len(steps[-1]["frames"]) == 1:
                    time.sleep(0.05)
                    relay.drain()
                    end = json.loads(json.dumps(steps[-1]))
                    end["event"] = "return"
                    end["stdoutLength"] = relay.printed
                    steps.append(end)
                break
            thread = body.get("threadId") or thread
            relay.drain()
            frames = project_frames(client, thread)
            if body.get("reason") == "exception":
                text = cs.exception_text(client.request("exceptionInfo", threadId=thread))
                where = (text, frames[0].get("line") if frames else None)
                if tracing and where != last_exception:
                    add(snapshot(client, thread, "exception", exception=text))
                last_exception = where
                client.request("continue" if not tracing else "stepIn", threadId=thread)
                continue
            if not tracing or not frames:
                client.request("continue", threadId=thread)
                continue
            top_line = cs.source_lines((frames[0].get("source") or {}).get("path"))
            text_here = top_line[frames[0].get("line", 0) - 1].strip() if 0 < frames[0].get("line", 0) <= len(top_line) else ""
            if text_here in ("{", "}"):
                # A brace is where C# opens or leaves a block, not a line of the program's own.
                client.request("stepIn", threadId=thread)
                continue
            add(snapshot(client, thread, "line"))
            if len(steps) >= LIMITS["maxSteps"]:
                truncated = f"Recording stopped after {LIMITS['maxSteps']} steps; the program continued without recording."
                tracing = False
            elif time.monotonic() - started > BUDGET_S:
                truncated = "Recording stopped because the program ran for a long time; it continued without recording."
                tracing = False
            if not tracing:
                client.request("continue", threadId=thread)
                continue
            top = frames[0]
            expr = returned_expression((top.get("source") or {}).get("path"), top.get("line", 0))
            if expr is not None and len(frames) > 1 and steps:
                # The method returns on this line: what it returns, before it does.
                try:
                    got = client.request("evaluate", expression=expr, frameId=top.get("id"), context="watch")
                    ret = json.loads(json.dumps(steps[-1]))
                    ret["event"] = "return"
                    snap = Snapshot(client, top.get("id"))
                    ret["frames"][-1]["returnValue"] = snap.value({"value": got.get("result", ""), "type": got.get("type", ""), "variablesReference": got.get("variablesReference", 0), "evaluateName": expr})
                    ret["heap"].update({k: v for k, v in snap.heap.items() if k not in ret["heap"]})
                    steps.append(ret)
                except cs.DAPError:
                    pass
            client.request("stepIn", threadId=thread)
    except Exception as e:  # noqa: BLE001 - never leave the run without a trace or an explanation
        truncated = f"Recording stopped: {type(e).__name__}: {e}"
    if proc is not None:
        try:
            client.request("disconnect", timeout=3, terminateDebuggee=True)
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
    time.sleep(0.05)
    relay.drain()
    trace = {"language": "csharp", "steps": steps, "stdout": "".join(relay.text)}
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
