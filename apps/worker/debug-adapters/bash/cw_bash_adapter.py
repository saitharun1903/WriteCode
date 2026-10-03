"""Code Workspace Bash debug adapter.

Speaks newline-delimited JSON on stdin/stdout, the same protocol as the other
adapters:

  in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
       | setBreakpoints | variables | evaluate | terminate
  out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}

The script runs under the Bash prelude (cw_bash_prelude.sh) with its own
stdin; its stdout and stderr go through FIFOs and are relayed as "output"
events. Where the script stops, the prelude reports the call stack and every
variable, so variables and watches are answered here without running
anything in the script: a watch is a variable (`$x`, `${arr[1]}`,
`${#arr[@]}`, `${map[key]}`) or integer arithmetic on variables and numbers.
A command that is not found stops the script there, as an exception does in
other languages.
"""

import json
import os
import queue
import re
import signal
import sys
import threading

sys.path.insert(0, "/tmp/cwdbg")
import cw_bash as sh  # noqa: E402

MAX_CHILDREN = 200
PREVIEW_ITEMS = 8
PREVIEW_CHARS = 200
THREAD = "main"
OUT_FIFO = "/tmp/cw-out"
ERR_FIFO = "/tmp/cw-err"
PRELUDE = "/tmp/cwdbg/cw_bash_prelude.sh"

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


NOT_CODE = re.compile(r"^\s*(#.*|\{|\}|then|do|done|fi|else|esac|;;|(function\s+[\w:.-]+(\s*\(\))?|[\w:.-]+\s*\(\))\s*\{?)?\s*$")


class Adapter:
    def __init__(self):
        self.root = "/"
        self.files = []
        self.proc = None
        self.events = None
        self.commands_out = None
        self.breakpoints = {}  # file -> lines it stops on
        self.refs = {}
        self.next_ref = 1
        self.stop = None  # the report at the current stop
        self.queue = queue.Queue()
        self.running = False
        self.pumps = []
        self.exception = None

    # -- breakpoints

    def lines_of(self, file):
        try:
            with open(os.path.join(self.root, file), encoding="utf-8", errors="replace") as fh:
                return fh.read().split("\n")
        except OSError:
            return []

    def set_breakpoints(self, file, lines):
        lines = sorted({int(n) for n in lines})
        source = self.lines_of(file) if file in self.files else []
        stops = set()
        result = []
        for n in lines:
            # A line with no command (a comment, `do`, `fi`, a function's header) moves to the next one that has one.
            at = next((i for i in range(n, len(source) + 1) if not NOT_CODE.match(source[i - 1])), None)
            if at is None:
                result.append({"line": n, "verified": False})
            else:
                stops.add(at)
                result.append({"line": n, "verified": True, "actual": at})
        self.breakpoints[file] = stops
        self.write_breakpoints()
        return result

    def header(self, file, line):
        source = self.lines_of(file)
        return 0 < line <= len(source) and bool(NOT_CODE.match(source[line - 1]))

    def write_breakpoints(self):
        with open(sh.BREAKPOINTS, "w", encoding="utf-8") as fh:
            for file, lines in self.breakpoints.items():
                for n in sorted(lines):
                    fh.write(f"{file}:{n}\n")

    # -- stopping

    def announce(self, report):
        self.stop = report
        self.refs.clear()
        self.next_ref = 1
        frames = report["frames"] or [{"name": "main", "file": report["file"], "line": report["line"]}]
        body = {
            "reason": report["reason"] if report["reason"] in ("breakpoint", "step", "pause", "exception") else "step",
            "thread": THREAD,
            "frames": [{"id": i, "name": f["name"], "file": f["file"], "line": f["line"], "localsRef": self.register(("frame", i))} for i, f in enumerate(frames)],
        }
        if report["reason"] == "exception" and self.exception:
            body["description"] = self.exception
        event("stopped", **body)

    # -- variables

    def register(self, target):
        ref = self.next_ref
        self.next_ref += 1
        self.refs[ref] = target
        return ref

    def preview(self, kind, value):
        if kind == "array":
            items = sorted((value or {}).items(), key=lambda kv: int(kv[0]) if kv[0].lstrip("-").isdigit() else 0)
            more = ", …" if len(items) > PREVIEW_ITEMS else ""
            return "(" + " ".join(sh.text_of("string", v) for _, v in items[:PREVIEW_ITEMS]) + more + ")"
        if kind == "assoc":
            items = list((value or {}).items())
            more = ", …" if len(items) > PREVIEW_ITEMS else ""
            return "(" + " ".join(f"[{k}]={sh.text_of('string', v)}" for k, v in items[:PREVIEW_ITEMS]) + more + ")"
        return sh.text_of(kind, value)

    def describe(self, name, kind, value):
        d = {"name": name, "value": clip(self.preview(kind, value)), "type": {"array": "array", "assoc": "associative array", "integer": "integer"}.get(kind, "string"), "ref": 0}
        if kind in ("array", "assoc"):
            d["ref"] = self.register(("value", kind, value))
            d["length"] = len(value or {})
        return d

    def variables(self, ref):
        target = self.refs.get(ref)
        if target is None:
            raise RuntimeError("variable reference expired; the script has resumed")
        if target[0] == "frame":
            # Bash's variables are dynamically scoped: every frame sees the same ones.
            return [self.describe(name, kind, value) for name, kind, value in self.stop["variables"]][:MAX_CHILDREN]
        _, kind, value = target
        items = list((value or {}).items())
        if kind == "array":
            items.sort(key=lambda kv: int(kv[0]) if kv[0].lstrip("-").isdigit() else 0)
        return [self.describe(f"[{k}]", "string", v) for k, v in items[:MAX_CHILDREN]]

    def lookup(self, name, index=None, length=False):
        for n, kind, value in self.stop["variables"]:
            if n != name:
                continue
            if length:
                return str(len(value or {})) if kind in ("array", "assoc") else str(len(value or ""))
            if kind in ("array", "assoc"):
                key = "0" if index is None else index
                if kind == "array":
                    key = str(self.arith(key))
                return (value or {}).get(key, "")
            return "" if value is None else value
        return ""

    def arith(self, expr):
        """Integer arithmetic on numbers and variables, as $(( )) reads it, without running it in Bash."""
        def name(m):
            v = self.lookup(m.group(1))
            return v if sh.is_number(v) else "0"

        code = re.sub(r"\$?\{?([A-Za-z_]\w*)\}?", name, expr)
        if not re.fullmatch(r"[\d\s+\-*/%()<>=!&|]*", code):
            raise ValueError("only integer arithmetic on variables and numbers is evaluated")
        code = code.replace("&&", " and ").replace("||", " or ").replace("/", "//")
        code = re.sub(r"!(?!=)", " not ", code)
        result = eval(compile(code.strip(), "<watch>", "eval"), {"__builtins__": {}}, {})  # only digits and operators are left
        return int(result)

    def evaluate(self, expression):
        expr = expression.strip()
        if re.search(r"\$\((?!\()|`|;|(?<![=!<>])=(?!=)|\+\+|--", expr):
            return {"error": "Watches do not run commands or change variables: write a variable, or arithmetic on variables."}
        m = re.fullmatch(r"\$\{#([A-Za-z_]\w*)(\[[@*]\])?\}", expr)
        if m:
            return {"result": {"value": self.lookup(m.group(1), length=True), "type": "integer", "ref": 0}}
        m = re.fullmatch(r"\$\{([A-Za-z_]\w*)\[([^\]]+)\]\}", expr)
        if m:
            key = m.group(2)
            key = key[1:-1] if len(key) > 1 and key[0] == key[-1] and key[0] in "\"'" else key
            if key in ("@", "*"):
                for n, kind, value in self.stop["variables"]:
                    if n == m.group(1):
                        return {"result": {"value": clip(self.preview(kind, value)), "type": kind, "ref": 0}}
            v = self.lookup(m.group(1), key)
            return {"result": {"value": sh.text_of("string", v), "type": "string", "ref": 0}}
        m = re.fullmatch(r"\$\{?([A-Za-z_]\w*)\}?", expr)
        if m:
            for n, kind, value in self.stop["variables"]:
                if n == m.group(1):
                    return {"result": {"value": clip(self.preview(kind, value)), "type": kind, "ref": 0}}
            return {"error": f"{m.group(1)} is not set"}
        try:
            inner = re.fullmatch(r"\$\(\((.*)\)\)", expr)
            return {"result": {"value": str(self.arith(inner.group(1) if inner else expr)), "type": "integer", "ref": 0}}
        except ZeroDivisionError:
            return {"error": "division by 0"}
        except (ValueError, SyntaxError) as e:
            return {"error": str(e) if isinstance(e, ValueError) else "not an arithmetic expression"}

    # -- commands

    def handle(self, req):
        """Handles one command while stopped. Returns what to tell the script, or None."""
        seq, cmd = req.get("seq"), req.get("cmd")
        if cmd == "setBreakpoints":
            file = str(req.get("file") or "")
            respond(seq, file=file, breakpoints=self.set_breakpoints(file, req.get("lines") or []))
            self.tell("bp")
        elif cmd == "pause":
            respond(seq)
        elif cmd in ("continue", "stepOver", "stepIn", "stepOut"):
            respond(seq)
            if self.stop and self.stop["reason"] == "exception" and cmd != "continue":
                return "in"
            return {"continue": "continue", "stepOver": "over", "stepIn": "in", "stepOut": "out"}[cmd]
        elif cmd == "variables":
            ref = req.get("ref")
            respond(seq, ref=ref, variables=self.variables(ref))
        elif cmd == "evaluate":
            expr = str(req.get("expression", ""))
            respond(seq, expression=expr, **self.evaluate(expr))
        elif cmd == "terminate":
            respond(seq)
            self.kill()
            os._exit(0)
        else:
            respond(seq, False, f"unknown command: {cmd}")
        return None

    def safe_handle(self, req):
        try:
            return self.handle(req)
        except Exception as e:  # noqa: BLE001 - report every failure to the client
            respond(req.get("seq"), False, f"{type(e).__name__}: {e}")
            return None

    def tell(self, word):
        self.commands_out.write(word + "\n")
        self.commands_out.flush()

    def read_commands(self):
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
            if self.running and req.get("cmd") == "terminate":
                respond(req.get("seq"))
                self.kill()
                os._exit(0)
            if self.running and req.get("cmd") == "pause":
                self.signal(signal.SIGUSR1)
                respond(req.get("seq"))
                continue
            if self.running and req.get("cmd") == "setBreakpoints":
                file = str(req.get("file") or "")
                respond(req.get("seq"), file=file, breakpoints=self.set_breakpoints(file, req.get("lines") or []))
                self.signal(signal.SIGUSR2)
                continue
            self.queue.put(("command", req))
        self.kill()
        os._exit(0)

    def signal(self, sig):
        try:
            os.kill(self.proc.pid, sig)
        except OSError:
            pass

    def kill(self):
        if self.proc is not None:
            try:
                self.proc.kill()
            except OSError:
                pass

    def read_reports(self):
        while True:
            b = sh.read_block(self.events)
            self.queue.put(("report", b))
            if b is None:
                return

    # -- output

    def pump(self, path, stream):
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        fd = os.open(path, os.O_RDONLY)
        while True:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            text = decoder.decode(data, final=not data)
            if text:
                event("output", stream=stream, text=text)
            if not data:
                break
        os.close(fd)

    # -- running

    def launch(self, req):
        self.root = os.path.normpath(req.get("root") or os.getcwd())
        self.files = [str(f) for f in req.get("files") or []]
        os.chdir(self.root)
        for path in (OUT_FIFO, ERR_FIFO):
            if not os.path.exists(path):
                os.mkfifo(path)
        for path, stream in ((OUT_FIFO, "stdout"), (ERR_FIFO, "stderr")):
            t = threading.Thread(target=self.pump, args=(path, stream), daemon=True)
            t.start()
            self.pumps.append(t)
        for file, lines in (req.get("breakpoints") or {}).items():
            if lines:
                event("breakpoints", file=file, breakpoints=self.set_breakpoints(file, lines))
        self.write_breakpoints()
        stdin = req.get("stdinPath")
        stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
        self.proc, self.events, self.commands_out = sh.start(PRELUDE, req["entry"], self.files, "debug", stdin, OUT_FIFO, ERR_FIFO)
        threading.Thread(target=self.read_reports, daemon=True).start()

    def run(self):
        self.running = True
        pending = []
        while True:
            kind, item = self.queue.get()
            if kind == "command":
                pending.append(item)
                continue
            if item is None:
                break
            what, d = item
            if what == "exception":
                self.exception = f"command not found: {d['command']}"
                continue
            if d["reason"] == "step" and self.header(d["file"], d["line"]):
                # Into a function: on to its first command, as in the other languages.
                self.tell("in")
                continue
            self.running = False
            self.announce(d)
            for req in pending:
                self.queue.put(("command", req))
            pending = []
            word = None
            while word is None:
                k, req = self.queue.get()
                if k == "report":
                    # The script ended while stopped (it cannot): put it back for the loop.
                    self.queue.put((k, req))
                    break
                word = self.safe_handle(req)
            if word is None:
                continue
            event("continued")
            self.exception = None
            self.running = True
            self.tell(word)
        try:
            return self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.kill()
            return 1

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
    adapter.finish(adapter.run())


main()
