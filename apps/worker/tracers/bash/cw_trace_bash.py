"""Code Workspace Bash tracer (visualizer).

    python3 cw_trace_bash.py <config.json>

Runs the script under the Bash prelude (cw_bash_prelude.sh), which reports
every command of the project's files with the call stack and the script's
variables. Writes the trace as JSON, the same format as the other tracers:
strings and numbers as values, indexed arrays as lists, associative arrays as
tables.

Bash's variables are dynamically scoped, so a function sees every variable;
a frame is given the variables that appeared while it ran, and the script's
own frame the rest.
"""

import json
import os
import queue
import re
import sys
import threading
import time

CONFIG = json.load(open(sys.argv[1], encoding="utf-8"))
sys.path.insert(0, os.path.dirname(os.path.abspath(CONFIG.get("module", "/tmp/cwviz/cw_bash.py"))))
import cw_bash as sh  # noqa: E402

LIMITS = CONFIG["limits"]
FILES = list(CONFIG["files"])
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


def value(heap, frame, name, kind, raw):
    """A variable as a trace value: numbers and strings inline, arrays as objects of the step."""
    cap = LIMITS["maxItemsPerObject"]
    if kind in ("array", "assoc"):
        oid = f"{frame}:{name}"
        items = list((raw or {}).items())
        if kind == "array":
            items.sort(key=lambda kv: int(kv[0]) if kv[0].lstrip("-").isdigit() else 0)
            o = {"kind": "sequence", "type": "array", "items": [scalar(v) for _, v in items[:cap]]}
        else:
            o = {"kind": "map", "type": "associative array", "entries": [[{"kind": "value", "text": sh.text_of("string", k), "type": "key"}, scalar(v)] for k, v in items[:cap]]}
        if len(items) > cap:
            o["omitted"] = len(items) - cap
        heap[oid] = o
        return {"kind": "ref", "id": oid}
    return scalar(raw, kind)


def scalar(raw, kind="string"):
    text = sh.text_of(kind, raw)
    n = LIMITS["maxStringChars"]
    if len(text) > n + 2:
        text = text[: n + 1] + '…"'
    return {"kind": "value", "text": text, "type": "integer" if kind == "integer" or sh.is_number(raw) else "string"}


# The order each frame's variables were first seen in: Bash lists them alphabetically, the script writes them in its own order.
first_seen = {}


def in_order(name, local):
    seen = first_seen.setdefault(name, {})
    for n, _ in local:
        seen.setdefault(n, len(seen))
    return sorted(local, key=lambda kv: seen[kv[0]])


_sources = {}


def header(file, line):
    """A function's header line (`square() {`): Bash stops there on the way in; it is not a line of the function's own."""
    if file not in _sources:
        try:
            with open(os.path.join(CONFIG["root"], file), encoding="utf-8", errors="replace") as fh:
                _sources[file] = fh.read().split("\n")
        except OSError:
            _sources[file] = []
    lines = _sources[file]
    text = lines[line - 1] if 0 < line <= len(lines) else ""
    return re.match(r"\s*(function\s+[\w:.-]+(\s*\(\))?|[\w:.-]+\s*\(\))\s*\{?\s*$", text) is not None


def main():
    relay.open()
    stdin = CONFIG.get("stdin")
    stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
    os.chdir(CONFIG["root"])
    steps = []
    truncated = None
    proc = None
    # The variables that belong to the script's own frame: those seen while no function ran.
    script_names = set()

    def add(step):
        if steps and json.dumps(steps[-1], sort_keys=True) == json.dumps(step, sort_keys=True):
            return  # a failed command is reported twice (once more for the ERR trap)
        steps.append(step)

    try:
        proc, events, acks = sh.start(CONFIG["prelude"], CONFIG["entry"], FILES, "trace", stdin, OUT_FIFO, ERR_FIFO)

        def ack():
            # The script waits after each report: once it is recorded, it goes on.
            try:
                acks.write("ok\n")
                acks.flush()
            except OSError:
                pass
        blocks = queue.Queue()

        def read():
            while True:
                b = sh.read_block(events)
                blocks.put(b)
                if b is None:
                    return

        threading.Thread(target=read, daemon=True).start()
        started = time.monotonic()
        tracing = True
        while True:
            b = blocks.get()
            if b is None:
                break
            kind, d = b
            if not tracing:
                if kind == "step":
                    ack()
                continue
            relay.drain()
            if kind == "exception":
                if steps:
                    ex = json.loads(json.dumps(steps[-1]))
                    ex["event"] = "exception"
                    ex["exception"] = f"command not found: {d['command']}"
                    ex["stdoutLength"] = relay.printed
                    steps.append(ex)
                continue
            frames = list(reversed(d["frames"])) or [{"name": "main", "file": d["file"], "line": d["line"]}]
            if header(frames[-1]["file"], frames[-1]["line"]):
                ack()
                continue
            variables = d["variables"]
            if len(frames) == 1:
                script_names = {name for name, _, _ in variables}
            heap = {}
            out = []
            for i, f in enumerate(frames):
                own = [v for v in variables if (v[0] in script_names) == (i == 0)] if len(frames) > 1 else variables
                if i not in (0, len(frames) - 1) and len(frames) > 1:
                    own = []  # a middle frame: its variables cannot be told apart from the innermost one's
                local = [[name, value(heap, i, name, k, raw)] for name, k, raw in own]
                out.append({"name": f["name"], "file": f["file"], "line": f["line"], "locals": in_order(f["name"], local)})
            add({"event": "line", "frames": out, "heap": heap, "stdoutLength": relay.printed})
            ack()
            if len(steps) >= LIMITS["maxSteps"]:
                truncated = f"Recording stopped after {LIMITS['maxSteps']} steps; the program continued without recording."
                tracing = False
            elif time.monotonic() - started > BUDGET_S:
                truncated = "Recording stopped because the program ran for a long time; it continued without recording."
                tracing = False
        if tracing and steps and len(steps[-1]["frames"]) == 1:
            # The script ends after its last command: its end is a step, so what that command printed is in the trace.
            time.sleep(0.02)
            relay.drain()
            end = json.loads(json.dumps(steps[-1]))
            end["event"] = "return"
            end["stdoutLength"] = relay.printed
            steps.append(end)
    except Exception as e:  # noqa: BLE001 - never leave the run without a trace or an explanation
        truncated = f"Recording stopped: {type(e).__name__}: {e}"
    code = 0
    if proc is not None:
        try:
            code = proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
            code = 1
    time.sleep(0.05)
    relay.drain()
    trace = {"language": "bash", "steps": steps, "stdout": "".join(relay.text)}
    if truncated:
        trace["truncated"] = truncated
    text = json.dumps(trace, ensure_ascii=False)
    while len(text) > LIMITS["maxTraceBytes"] and len(trace["steps"]) > 1:
        trace["steps"] = trace["steps"][: int(len(trace["steps"]) * 0.8)]
        trace["truncated"] = "The recording was too large; the last steps were dropped."
        text = json.dumps(trace, ensure_ascii=False)
    with open(CONFIG["out"], "w", encoding="utf-8") as fh:
        fh.write(text)
    sys.exit(int(code or 0) & 0xFF)


main()
