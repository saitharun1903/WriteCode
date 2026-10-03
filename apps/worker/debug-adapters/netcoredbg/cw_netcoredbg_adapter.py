"""Code Workspace C# debug adapter, driving netcoredbg.

Speaks newline-delimited JSON on stdin/stdout, the same protocol as the other
adapters:

  in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
       | setBreakpoints | variables | evaluate | terminate
  out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}

The program runs under netcoredbg with its own stdin (the input file or the
typed-input FIFO); its stdout and stderr go through FIFOs and are relayed as
"output" events. Stepping stays in the program's own code (Just My Code). An
unhandled exception stops the program where it was thrown. Collections are
shown as their elements. Watch expressions read variables, fields, elements
and properties, and do arithmetic and comparisons; they do not call methods
or assign.
"""

import json
import os
import queue
import re
import sys
import threading

sys.path.insert(0, "/tmp/cwdbg")
import cw_netcoredbg as cs  # noqa: E402

MAX_CHILDREN = 200
PREVIEW_ITEMS = 8
PREVIEW_CHARS = 200
THREAD = "main"
OUT_FIFO = "/tmp/cw-out"
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


def checked(expression):
    """None when the watch only reads; otherwise why it is not evaluated."""
    code = re.sub(r"'(\\.|[^'\\])*'|\"(\\.|[^\"\\])*\"", "", expression)
    if re.search(r"(?<![=!<>])=(?![=>])|\+\+|--|\+=|-=", code):
        return "Watches do not change the program: assignments and ++/-- are not evaluated."
    if re.search(r"\bnew\b", code):
        return "Watches do not create objects."
    for m in re.finditer(r"([A-Za-z_][\w.]*)\s*\(", code):
        if not re.fullmatch(r"Math\.(Abs|Max|Min|Pow|Sqrt|Floor|Ceiling|Round)", m.group(1)):
            return "Watches do not call methods, because that would run program code."
    return None


class Adapter:
    def __init__(self):
        self.project = cs.Project("/", [])
        self.client = None
        self.proc = None
        self.reader = None
        self.breakpoints = {}  # file -> requested lines
        self.status = {}  # file -> {dap breakpoint id: requested line}
        self.refs = {}
        self.next_ref = 1
        self.stack = []  # program frames at the stop, innermost first
        self.thread = None
        self.commands = queue.Queue()
        self.running = False
        self.pumps = []
        self.last_exception = None

    # -- breakpoints

    def set_breakpoints(self, file, lines):
        lines = sorted({int(n) for n in lines})
        if file not in self.project.files:
            return [{"line": n, "verified": False} for n in lines]
        path = os.path.join(self.project.root, file)
        got = self.client.request("setBreakpoints", source={"path": path}, breakpoints=[{"line": n} for n in lines]).get("breakpoints") or []
        self.breakpoints[file] = lines
        self.status[file] = {b.get("id"): n for b, n in zip(got, lines)}
        # netcoredbg places them when the program is loaded: until then a breakpoint is reported where it was set.
        return [{"line": n, "verified": True, "actual": b.get("line", n) if b.get("verified") else n} for b, n in zip(got, lines)]

    def on_breakpoint(self, bp):
        """netcoredbg placed a breakpoint once the program was loaded: report the line it really stops on."""
        for file, ids in self.status.items():
            if bp.get("id") in ids:
                n = ids[bp["id"]]
                event("breakpoints", file=file, breakpoints=[{"line": n, "verified": bool(bp.get("verified")), "actual": bp.get("line", n)}] if bp.get("verified") else [{"line": n, "verified": False}])

    # -- stopping

    def frames(self, thread):
        try:
            frames = self.client.request("stackTrace", threadId=thread, levels=200).get("stackFrames") or []
        except cs.DAPError:
            return []
        return [f for f in frames if self.project.file((f.get("source") or {}).get("path"))]

    def announce(self, reason, description):
        self.stack = self.frames(self.thread)
        self.refs.clear()
        self.next_ref = 1
        self.reader = cs.Reader(self.client)
        frames = [
            {"id": n, "name": cs.frame_name(f.get("name")), "file": self.project.file((f.get("source") or {}).get("path")), "line": f.get("line", 0), "localsRef": self.register(("frame", f))}
            for n, f in enumerate(self.stack)
        ]
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

    def preview(self, v, depth=0):
        if cs.is_null(v):
            return "null"
        text = cs.scalar_text(v)
        if text is not None:
            return text if depth == 0 or len(text) <= 60 else text[:60] + "…"
        shape = self.reader.elements(v, PREVIEW_ITEMS)
        if shape is not None:
            kind, items, total = shape
            if depth > 1:
                return "[…]"
            more = ", …" if total > len(items) else ""
            if kind == "map":
                return "{" + ", ".join(f"{self.preview(k, depth + 1)}: {self.preview(x, depth + 1)}" for k, x in items) + more + "}"
            return "[" + ", ".join(self.preview(x, depth + 1) for x in items) + more + "]"
        name = cs.type_name(v.get("type"))
        if depth > 1:
            return f"{name} {{…}}"
        fields = cs.own_fields(self.reader.kids(v.get("variablesReference")))
        more = ", …" if len(fields) > PREVIEW_ITEMS else ""
        return f"{name} {{" + ", ".join(f"{k.get('name')}: {self.preview(k, depth + 1)}" for k in fields[:PREVIEW_ITEMS]) + more + "}"

    def describe(self, name, v):
        expandable = bool(v.get("variablesReference")) and not cs.is_null(v) and v.get("type") != "string"
        d = {"name": name, "value": clip(self.preview(v)), "type": cs.type_name(v.get("type")), "ref": self.register(("value", v)) if expandable else 0}
        shape = self.reader.elements(v, 0) if expandable else None
        if shape is not None:
            d["length"] = shape[2]
        return d

    def variables(self, ref):
        target = self.refs.get(ref)
        if target is None:
            raise RuntimeError("variable reference expired; the program has resumed")
        kind, obj = target
        if kind == "frame":
            scopes = self.client.request("scopes", frameId=obj.get("id")).get("scopes") or []
            kids = self.reader.kids(scopes[0].get("variablesReference")) if scopes else []
            shown = cs.declared((obj.get("source") or {}).get("path"), obj.get("line", 0), [k.get("name") for k in kids])
            return [self.describe(k.get("name", "?"), k) for k in kids if k.get("name") in shown or k.get("name", "").startswith("$")][:MAX_CHILDREN]
        shape = self.reader.elements(obj, MAX_CHILDREN)
        if shape is not None:
            kind, items, total = shape
            if kind == "map":
                out = [self.describe(clip(self.preview(k, 1)), x) for k, x in items]
            else:
                out = [self.describe(f"[{i}]", x) for i, x in enumerate(items)]
            if total > len(items):
                out.append({"name": "…", "value": f"{total - len(items)} more", "type": "", "ref": 0})
            return out
        return [self.describe(k.get("name", "?"), k) for k in cs.own_fields(self.reader.kids(obj.get("variablesReference")))][:MAX_CHILDREN]

    def evaluate(self, expression, index):
        if not (0 <= index < len(self.stack)):
            return {"error": "That frame is no longer available."}
        problem = checked(expression)
        if problem:
            return {"error": problem}
        try:
            got = self.client.request("evaluate", expression=expression, frameId=self.stack[index].get("id"), context="watch")
        except cs.DAPError as e:
            text = re.sub(r"^error:\s*", "", str(e))
            return {"error": "This expression cannot be evaluated here." if re.fullmatch(r"0x[0-9a-fA-F]+", text) else text}
        v = {"value": got.get("result", ""), "type": got.get("type", ""), "variablesReference": got.get("variablesReference", 0)}
        d = self.describe(expression, v)
        d.pop("name", None)
        return {"result": d}

    # -- commands

    def handle(self, req):
        """Handles one command while stopped. Returns the DAP request that resumes, or None."""
        seq, cmd = req.get("seq"), req.get("cmd")
        if cmd == "setBreakpoints":
            file = str(req.get("file") or "")
            respond(seq, file=file, breakpoints=self.set_breakpoints(file, req.get("lines") or []))
        elif cmd == "pause":
            respond(seq)
        elif cmd in ("continue", "stepOver", "stepIn", "stepOut"):
            respond(seq)
            if cmd == "stepOut" and len(self.stack) <= 1:
                return "continue"
            return {"continue": "continue", "stepOver": "next", "stepIn": "stepIn", "stepOut": "stepOut"}[cmd]
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

    def safe_handle(self, req):
        try:
            return self.handle(req)
        except Exception as e:  # noqa: BLE001 - report every failure to the client
            respond(req.get("seq"), False, f"{type(e).__name__}: {e}")
            return None

    def read_commands(self):
        """Runs on its own thread: while the program runs, pause and breakpoint changes go to netcoredbg at once."""
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
                try:
                    self.client.request("pause", threadId=self.thread or 0)
                    respond(req.get("seq"))
                except cs.DAPError as e:
                    respond(req.get("seq"), False, str(e))
                continue
            if self.running and req.get("cmd") == "setBreakpoints":
                self.safe_handle(req)
                continue
            self.commands.put(req)
        self.kill()
        os._exit(0)

    def kill(self):
        if self.client is not None:
            try:
                self.client.request("disconnect", timeout=3, terminateDebuggee=True)
            except Exception:  # noqa: BLE001
                pass
        if self.proc is not None:
            try:
                self.proc.kill()
            except OSError:
                pass

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
        self.project = cs.Project(req.get("root") or os.getcwd(), [str(f) for f in req.get("files") or []])
        os.chdir(self.project.root)
        for path in (OUT_FIFO, ERR_FIFO):
            if not os.path.exists(path):
                os.mkfifo(path)
        for path, stream in ((OUT_FIFO, "stdout"), (ERR_FIFO, "stderr")):
            t = threading.Thread(target=self.pump, args=(path, stream), daemon=True)
            t.start()
            self.pumps.append(t)
        stdin = req.get("stdinPath")
        stdin = stdin if stdin and os.path.exists(stdin) else "/dev/null"
        self.proc, self.client = cs.start(os.path.join(self.project.root, req.get("program", "out/main.dll")), stdin, OUT_FIFO, ERR_FIFO)
        # Where an exception is thrown, while its frame's variables are still there (also when the program catches it).
        self.client.request("setExceptionBreakpoints", filters=["all"])
        for file, lines in (req.get("breakpoints") or {}).items():
            if lines:
                event("breakpoints", file=file, breakpoints=self.set_breakpoints(file, lines))
        self.client.request("configurationDone")

    def run(self):
        code = None
        self.running = True
        while True:
            e = self.client.event(("stopped", "exited", "terminated", "breakpoint", "thread"))
            name = e.get("event")
            body = e.get("body") or {}
            if name == "breakpoint":
                self.on_breakpoint(body.get("breakpoint") or {})
                continue
            if name == "thread":
                if body.get("reason") == "started" and self.thread is None:
                    self.thread = body.get("threadId")
                continue
            if name == "exited":
                code = body.get("exitCode")
                continue
            if name == "terminated":
                break
            self.running = False
            self.thread = body.get("threadId") or self.thread
            reason = body.get("reason") or "step"
            description = None
            if reason == "exception":
                try:
                    description = cs.exception_text(self.client.request("exceptionInfo", threadId=self.thread))
                except cs.DAPError:
                    description = body.get("text") or "exception"
            reason = reason if reason in ("breakpoint", "step", "pause", "exception") else "step"
            top = self.frames(self.thread)[:1]
            if reason == "step" and top:
                lines = cs.source_lines((top[0].get("source") or {}).get("path"))
                line = top[0].get("line", 0)
                if 0 < line <= len(lines) and lines[line - 1].strip() == "{":
                    # Into a method: on to its first statement, as in the other languages.
                    self.running = True
                    self.client.request("next", threadId=self.thread)
                    continue
            where = (description, top[0].get("line") if top else None)
            if reason == "exception" and where == self.last_exception:
                # The same exception again, now unhandled, on its way out: it was already shown where it was thrown.
                self.running = True
                self.client.request("continue", threadId=self.thread)
                continue
            self.last_exception = where if reason == "exception" else None
            if not top and reason == "step":
                # Out of the program's own code (it has finished): on to the end.
                self.running = True
                self.client.request("continue", threadId=self.thread)
                continue
            self.announce(reason, description)
            command = None
            while command is None:
                command = self.safe_handle(self.commands.get())
            event("continued")
            self.running = True
            try:
                self.client.request(command, threadId=self.thread)
            except cs.DAPError as err:
                event("error", message=f"{command}: {err}")
        return code

    def finish(self, code):
        for t in self.pumps:
            t.join(3)
        self.kill()
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
