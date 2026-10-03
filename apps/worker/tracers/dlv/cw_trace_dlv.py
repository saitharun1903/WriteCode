"""Code Workspace Go tracer (visualizer), driving Delve.

    python3 cw_trace_dlv.py <config.json>

Starts the compiled program under Delve, stops at main.main, then steps
through every line of the program's own files, recording the call stack with
each frame's variables and the objects they reach (structs, pointers, slices,
arrays, maps). Steps into Go's own packages are stepped back out of. Writes
the trace as JSON, the same format as the other tracers.

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
sys.path.insert(0, os.path.dirname(os.path.abspath(CONFIG.get("module", "/tmp/cwviz/cw_dlv.py"))))
import cw_dlv as dlv  # noqa: E402

LIMITS = CONFIG["limits"]
PROJECT = dlv.Project(CONFIG["root"], CONFIG["files"])
OUT_FIFO = "/tmp/cw-trace-out"
ERR_FIFO = "/tmp/cw-trace-err"
BUDGET_S = 14.0
CFG = dlv.load_config(depth=4, items=LIMITS["maxItemsPerObject"], strings=LIMITS["maxStringChars"])


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
            # Read-write so opening never blocks and the pipe stays open between writes.
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
    """Objects reachable from the frames at one step, by address and type."""

    def __init__(self, client, gid):
        self.client = client
        self.gid = gid
        self.heap = {}

    def full(self):
        return len(self.heap) >= LIMITS["maxObjectsPerStep"]

    def value(self, v):
        v = dlv.unwrap(v) if v.get("kind") == dlv.INTERFACE else v
        if v is None:
            return {"kind": "value", "text": "nil", "type": "nil"}
        k = v.get("kind")
        tname = dlv.type_name(v.get("type"))
        if k in dlv.NUMBERS or k in (dlv.BOOL, dlv.STRING):
            return {"kind": "value", "text": dlv.scalar_text(v), "type": tname}
        if dlv.is_nil(v):
            return {"kind": "value", "text": "nil", "type": tname}
        if k == dlv.PTR:
            target = (v.get("children") or [None])[0]
            if target is not None and target.get("kind") in (dlv.STRUCT, dlv.ARRAY, dlv.SLICE, dlv.MAP):
                return self.value(target)
            if target is not None and (target.get("kind") in dlv.NUMBERS or target.get("kind") in (dlv.BOOL, dlv.STRING)):
                return {"kind": "value", "text": "&" + dlv.scalar_text(target), "type": tname}
            return {"kind": "value", "text": v.get("value", "?"), "type": tname}
        if k == dlv.STRUCT:
            return self.register(f"{v.get('addr')}:{tname}", lambda: self.struct(v, tname)) or {"kind": "value", "text": "{…}", "type": tname}
        if k in (dlv.SLICE, dlv.ARRAY):
            key = f"{v.get('base') or v.get('addr')}:{v.get('len')}:{tname}"
            return self.register(key, lambda: self.sequence(v, tname)) or {"kind": "value", "text": "[…]", "type": tname}
        if k == dlv.MAP:
            return self.register(f"{v.get('addr')}:{tname}", lambda: self.map(v, tname)) or {"kind": "value", "text": "map[…]", "type": tname}
        return {"kind": "value", "text": {dlv.FUNC: "func", dlv.CHAN: "chan"}.get(k, v.get("value") or tname), "type": tname}

    def register(self, oid, make):
        if oid in self.heap:
            return {"kind": "ref", "id": oid}
        if self.full():
            return None
        self.heap[oid] = {"kind": "other", "type": "", "text": "…"}  # placeholder against cycles
        self.heap[oid] = make()
        return {"kind": "ref", "id": oid}

    def loaded(self, v):
        """`v` with its children: Delve stops loading a few levels down; what was left out is read now."""
        if v.get("children") or not v.get("len"):
            return v
        try:
            got = self.client.call("Eval", Scope={"GoroutineID": self.gid, "Frame": 0}, Expr=f"*(*{v['type']})({v['addr']:#x})", Cfg=CFG)
            return got.get("Variable") or v
        except dlv.RPCError:
            return v

    def struct(self, v, tname):
        v = self.loaded(v)
        fields = [[c.get("name", "?"), self.value(c)] for c in (v.get("children") or [])[: LIMITS["maxItemsPerObject"]]]
        o = {"kind": "object", "type": tname, "fields": fields}
        if v.get("len", 0) > len(fields):
            o["omitted"] = v["len"] - len(fields)
        return o

    def sequence(self, v, tname):
        v = self.loaded(v)
        items = [self.value(c) for c in (v.get("children") or [])]
        o = {"kind": "sequence", "type": tname, "items": items}
        if v.get("len", 0) > len(items):
            o["omitted"] = v["len"] - len(items)
        return o

    def map(self, v, tname):
        v = self.loaded(v)
        kids = v.get("children") or []
        entries = [[self.value(kids[i]), self.value(kids[i + 1])] for i in range(0, len(kids) - 1, 2)]
        o = {"kind": "map", "type": tname, "entries": entries}
        if v.get("len", 0) > len(entries):
            o["omitted"] = v["len"] - len(entries)
        return o


def project_frames(client, gid):
    """(index in the whole stack, location) of the program's own frames, innermost first."""
    try:
        locations = client.call("Stacktrace", Id=gid, Depth=64).get("Locations") or []
    except dlv.RPCError:
        return []
    return [(i, loc) for i, loc in enumerate(locations) if PROJECT.file(loc.get("file"))]


def variables(client, gid, index):
    scope = {"GoroutineID": gid, "Frame": index}
    try:
        args = client.call("ListFunctionArgs", Scope=scope, Cfg=CFG).get("Args") or []
        local = client.call("ListLocalVars", Scope=scope, Cfg=CFG).get("Variables") or []
    except dlv.RPCError:
        return []
    return [v for v in args + local if v.get("name") and not v["name"].startswith("~") and not v.get("flags", 0) & (dlv.SHADOWED | dlv.RETURN_ARGUMENT)]


def snapshot(client, gid, event, exception=None):
    frames = project_frames(client, gid)
    if not frames:
        return None
    snap = Snapshot(client, gid)
    out = []
    for index, loc in reversed(frames):
        out.append({
            "name": dlv.function_name((loc.get("function") or {}).get("name")),
            "file": PROJECT.file(loc.get("file")),
            "line": loc.get("line", 0),
            "locals": [[v["name"], snap.value(v)] for v in variables(client, gid, index)],
        })
    relay.drain()
    step = {"event": event, "frames": out, "heap": snap.heap, "stdoutLength": relay.printed}
    if exception:
        step["exception"] = exception
    return step, snap


CALL = re.compile(r"[A-Za-z_]\w*\s*\(")
NOT_CALLS = {"return", "if", "for", "switch", "func"}


def returns_without_calls(path, line):
    """A `return x` that calls nothing: finishing it runs none of the program's code."""
    code = re.sub(r"//.*$|\"(\\.|[^\"])*\"|`[^`]*`|'(\\.|[^'])*'", "", dlv.source_line(path, line)).strip()
    if not re.match(r"return\b", code):
        return False
    return not any(m.group(0).split("(")[0].strip() not in NOT_CALLS for m in CALL.finditer(code))


def main():
    relay.open()
    stdin = CONFIG.get("stdin")
    stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
    os.chdir(PROJECT.root)
    proc = dlv.start(CONFIG.get("program", "out/main"), stdin, OUT_FIFO, ERR_FIFO)
    steps = []
    truncated = None
    exit_code = 0

    def add(step):
        if step is None:
            return
        if steps and json.dumps(steps[-1], sort_keys=True) == json.dumps(step, sort_keys=True):
            return
        steps.append(step)

    try:
        client = dlv.Client()
        client.call("CreateBreakpoint", Breakpoint={"functionName": "main.main"})
        state = client.call("Command", name="continue")["State"]
        started = time.monotonic()
        tracing = True
        while not state.get("exited"):
            relay.drain()
            thread = state.get("currentThread") or {}
            gid = thread.get("goroutineID", 1)
            bp = thread.get("breakPoint") or {}
            if bp.get("name") in ("unrecovered-panic", "runtime-fatal-throw"):
                if tracing:
                    arg = ((thread.get("breakPointInfo") or {}).get("variables") or [None])[0]
                    got = snapshot(client, gid, "exception", exception=f"panic: {dlv.panic_message(arg)}")
                    add(got and got[0])
                tracing = False
                state = client.call("Command", name="continue")["State"]
                continue
            if not tracing:
                state = client.call("Command", name="continue")["State"]
                continue
            file = PROJECT.file(thread.get("file"))
            if file is None:
                # In Go's own code: back to the program, or on to the end once the program's code is done.
                state = client.call("Command", name="stepOut" if project_frames(client, gid) else "continue")["State"]
                continue
            if dlv.at_func_line(thread):
                state = client.call("Command", name="next")["State"]
                continue
            got = snapshot(client, gid, "line")
            add(got and got[0])
            if len(steps) >= LIMITS["maxSteps"]:
                truncated = f"Recording stopped after {LIMITS['maxSteps']} steps; the program continued without recording."
                tracing = False
                continue
            if time.monotonic() - started > BUDGET_S:
                truncated = "Recording stopped because the program ran for a long time; it continued without recording."
                tracing = False
                continue
            function = (thread.get("function") or {}).get("name")
            if function != "main.main" and returns_without_calls(thread.get("file"), thread.get("line", 0)) and steps:
                # The function returns on this line: finish it, to show what it returns.
                state = client.call("Command", name="stepOut", ReturnInfoLoadConfig=CFG)["State"]
                returned = (state.get("currentThread") or {}).get("ReturnValues") or []
                if returned and not state.get("exited"):
                    ret = json.loads(json.dumps(steps[-1]))
                    ret["event"] = "return"
                    snap = Snapshot(client, gid)
                    ret["frames"][-1]["returnValue"] = snap.value(returned[0])
                    ret["heap"].update({k: v for k, v in snap.heap.items() if k not in ret["heap"]})
                    relay.drain()
                    ret["stdoutLength"] = relay.printed
                    steps.append(ret)
                continue
            state = client.call("Command", name="step")["State"]
        exit_code = state.get("exitStatus", 0)
        try:
            client.call("Detach", Kill=True)
        except dlv.RPCError:
            pass
    except Exception as e:  # noqa: BLE001 - never leave the run without a trace or an explanation
        truncated = f"Recording stopped: {type(e).__name__}: {e}"
        try:
            while proc.poll() is None:
                relay.drain()
                time.sleep(0.02)
        except Exception:  # noqa: BLE001
            pass
        exit_code = proc.returncode or 0
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001
        proc.kill()
    time.sleep(0.05)
    relay.drain()
    trace = {"language": "go", "steps": steps, "stdout": "".join(relay.text)}
    if truncated:
        trace["truncated"] = truncated
    text = json.dumps(trace, ensure_ascii=False)
    while len(text) > LIMITS["maxTraceBytes"] and len(trace["steps"]) > 1:
        trace["steps"] = trace["steps"][: int(len(trace["steps"]) * 0.8)]
        trace["truncated"] = "The recording was too large; the last steps were dropped."
        text = json.dumps(trace, ensure_ascii=False)
    with open(CONFIG["out"], "w", encoding="utf-8") as fh:
        fh.write(text)
    sys.exit(int(exit_code) & 0xFF)


main()
