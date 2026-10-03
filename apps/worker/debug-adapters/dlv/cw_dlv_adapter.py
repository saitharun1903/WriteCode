"""Code Workspace Go debug adapter, driving Delve.

Speaks newline-delimited JSON on stdin/stdout, the same protocol as the other
adapters:

  in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
       | setBreakpoints | variables | evaluate | terminate
  out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}

The program is Delve's child with its own stdin (the input file or the
typed-input FIFO); its stdout and stderr go through FIFOs and are relayed as
"output" events. Stepping stays in the program's own files: a step into Go's
own packages is stepped back out of. Values are read by Delve; watch
expressions are evaluated by Delve, which does not call functions or assign
in an expression, so inspecting never changes the program. An unrecovered
panic stops the program where its code panicked, with the panic's message.
"""

import json
import os
import queue
import re
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[0])) if sys.argv and sys.argv[0] else "/tmp/cwdbg")
sys.path.insert(0, "/tmp/cwdbg")
import cw_dlv as dlv  # noqa: E402

MAX_CHILDREN = 200
MAX_FRAMES = 200
PREVIEW_ITEMS = 8
PREVIEW_CHARS = 200
THREAD = "main"
OUT_FIFO = "/tmp/cw-out"
ERR_FIFO = "/tmp/cw-err"
CFG = dlv.load_config(depth=1, items=MAX_CHILDREN, strings=500)
PREVIEW_CFG = dlv.load_config(depth=2, items=PREVIEW_ITEMS + 1, strings=200)

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


# ------------------------------------------------------------------ values


def preview(v, depth=0):
    """Short text: `3`, `"ada"`, `[3, 1, 2]`, `{Value: 1, Next: &{…}}`, `{"ada": 36}`, `nil`."""
    if v.get("kind") == dlv.INTERFACE:
        inner = dlv.unwrap(v)
        return "nil" if inner is None else preview(inner, depth)
    k = v.get("kind")
    if k in dlv.NUMBERS or k in (dlv.BOOL, dlv.STRING):
        return dlv.scalar_text(v)
    if dlv.is_nil(v):
        return "nil"
    kids = v.get("children") or []
    if k == dlv.PTR:
        target = kids[0] if kids else None
        if target is None:
            return v.get("value", "?")
        return "&" + preview(target, depth)
    if k in (dlv.SLICE, dlv.ARRAY):
        if depth > 1:
            return "[…]"
        more = ", …" if v.get("len", 0) > min(len(kids), PREVIEW_ITEMS) else ""
        return "[" + ", ".join(preview(c, depth + 1) for c in kids[:PREVIEW_ITEMS]) + more + "]"
    if k == dlv.MAP:
        if depth > 1:
            return "{…}"
        pairs = [(kids[i], kids[i + 1]) for i in range(0, min(len(kids), PREVIEW_ITEMS * 2) - 1, 2)]
        more = ", …" if v.get("len", 0) > len(pairs) else ""
        return "{" + ", ".join(f"{preview(a, depth + 1)}: {preview(b, depth + 1)}" for a, b in pairs) + more + "}"
    if k == dlv.STRUCT:
        if depth > 1 or (not kids and v.get("len")):
            return "{…}"
        more = ", …" if v.get("len", 0) > min(len(kids), PREVIEW_ITEMS) else ""
        return "{" + ", ".join(f"{c.get('name')}: {preview(c, depth + 1)}" for c in kids[:PREVIEW_ITEMS]) + more + "}"
    if k == dlv.FUNC:
        return "func " + dlv.function_name(v.get("value") or "")
    return v.get("value") or dlv.type_name(v.get("type"))


def expandable(v):
    v2 = dlv.unwrap(v) if v.get("kind") == dlv.INTERFACE else v
    if v2 is None or dlv.is_nil(v2):
        return False
    k = v2.get("kind")
    if k == dlv.PTR:
        target = (v2.get("children") or [None])[0]
        return target is not None and target.get("kind") in (dlv.STRUCT, dlv.SLICE, dlv.ARRAY, dlv.MAP) and (target.get("len", 0) > 0 or bool(target.get("children")))
    return k in (dlv.STRUCT, dlv.SLICE, dlv.ARRAY, dlv.MAP) and v2.get("len", 0) > 0


def key_literal(v):
    """A map key as Go source, so its value can be read again by expression; None when it cannot be written."""
    k = v.get("kind")
    if k == dlv.STRING:
        return json.dumps(v.get("value", ""))
    if k in dlv.NUMBERS or k == dlv.BOOL:
        return v.get("value")
    return None


# ------------------------------------------------------------------ adapter


class Adapter:
    def __init__(self):
        self.project = dlv.Project("/", [])
        self.client = None  # commands that run the program
        self.side = None  # a second connection: pause while the program runs
        self.proc = None
        self.breakpoints = {}  # file -> {line: breakpoint id}
        self.refs = {}
        self.next_ref = 1
        self.stack = []  # (index in the whole stack, location) of the program's frames, innermost first
        self.gid = 1
        self.commands = queue.Queue()
        self.running = False
        self.pause_requested = False
        self.stop_reason = None
        self.pumps = []

    # -- breakpoints

    def set_breakpoints(self, file, lines):
        lines = sorted({int(n) for n in lines})
        for bid in self.breakpoints.pop(file, {}).values():
            try:
                self.side.call("ClearBreakpoint", Id=bid)
            except dlv.RPCError:
                pass
        placed = {}
        result = []
        path = os.path.join(self.project.root, file)
        for line in lines:
            ok = False
            # A line with no code moves to the next one that has some: say which, so the editor shows it there.
            for at in range(line, line + 30):
                if file not in self.project.files:
                    break
                try:
                    bp = self.side.call("CreateBreakpoint", Breakpoint={"file": path, "line": at})["Breakpoint"]
                except dlv.RPCError as e:
                    if "already exists" in str(e):
                        ok = True
                        result.append({"line": line, "verified": True, "actual": at})
                        break
                    continue
                placed[line] = bp["id"]
                result.append({"line": line, "verified": True, "actual": bp.get("line", at)})
                ok = True
                break
            if not ok:
                result.append({"line": line, "verified": False})
        if placed:
            self.breakpoints[file] = placed
        return result

    # -- stopping

    def frames(self):
        try:
            locations = self.client.call("Stacktrace", Id=self.gid, Depth=MAX_FRAMES).get("Locations") or []
        except dlv.RPCError:
            return []
        return [(i, loc) for i, loc in enumerate(locations) if self.project.file(loc.get("file"))]

    def announce(self, reason, description):
        self.stack = self.frames()
        self.refs.clear()
        self.next_ref = 1
        self.stop_reason = reason
        frames = [
            {
                "id": n,
                "name": dlv.function_name((loc.get("function") or {}).get("name")),
                "file": self.project.file(loc.get("file")),
                "line": loc.get("line", 0),
                "localsRef": self.register(("frame", index, None)),
            }
            for n, (index, loc) in enumerate(self.stack)
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

    def format(self, v, frame, expr):
        d = {"value": clip(preview(v)), "type": dlv.type_name(v.get("type")), "ref": self.register(("value", frame, expr)) if expr and expandable(v) else 0}
        inner = dlv.unwrap(v) if v.get("kind") == dlv.INTERFACE else v
        if inner is not None and inner.get("kind") in (dlv.SLICE, dlv.ARRAY, dlv.MAP):
            d["length"] = inner.get("len", 0)
        return d

    def describe(self, name, v, frame, expr):
        d = self.format(v, frame, expr)
        d["name"] = name
        return d

    def eval(self, frame, expr, cfg=CFG):
        return self.client.call("Eval", Scope={"GoroutineID": self.gid, "Frame": frame}, Expr=expr, Cfg=cfg)["Variable"]

    def frame_vars(self, frame):
        scope = {"GoroutineID": self.gid, "Frame": frame}
        args = self.client.call("ListFunctionArgs", Scope=scope, Cfg=PREVIEW_CFG).get("Args") or []
        local = self.client.call("ListLocalVars", Scope=scope, Cfg=PREVIEW_CFG).get("Variables") or []
        out = []
        for v in args + local:
            name = v.get("name") or ""
            if not name or name.startswith("~") or v.get("flags", 0) & (dlv.SHADOWED | dlv.RETURN_ARGUMENT):
                continue
            out.append(self.describe(name, v, frame, name))
        return out[:MAX_CHILDREN]

    def children(self, frame, expr):
        v = self.eval(frame, expr)
        if v.get("kind") == dlv.INTERFACE:
            v = dlv.unwrap(v) or v
        k = v.get("kind")
        if k == dlv.PTR:
            # A pointer opens on what it points at.
            expr = f"(*{expr})"
            v = (v.get("children") or [v])[0]
            k = v.get("kind")
        kids = v.get("children") or []
        out = []
        if k == dlv.STRUCT:
            out = [self.describe(c.get("name", "?"), self.with_preview(frame, f"{expr}.{c.get('name')}", c), frame, f"{expr}.{c.get('name')}") for c in kids]
        elif k in (dlv.SLICE, dlv.ARRAY):
            out = [self.describe(f"[{i}]", self.with_preview(frame, f"{expr}[{i}]", c), frame, f"{expr}[{i}]") for i, c in enumerate(kids)]
        elif k == dlv.MAP:
            for i in range(0, len(kids) - 1, 2):
                key = key_literal(kids[i])
                child = f"{expr}[{key}]" if key is not None else None
                value = self.with_preview(frame, child, kids[i + 1]) if child else kids[i + 1]
                out.append(self.describe(clip(preview(kids[i], 1)), value, frame, child))
        if v.get("len", 0) > len(kids) and k in (dlv.SLICE, dlv.ARRAY, dlv.MAP):
            shown = len(kids) // 2 if k == dlv.MAP else len(kids)
            out.append({"name": "…", "value": f"{v['len'] - shown} more", "type": "", "ref": 0})
        return out

    def with_preview(self, frame, expr, v):
        """A child read one level deep has no children of its own to preview: read it again a little deeper."""
        if expr and v.get("kind") in (dlv.STRUCT, dlv.PTR, dlv.SLICE, dlv.ARRAY, dlv.MAP, dlv.INTERFACE) and not v.get("children") and v.get("len"):
            try:
                return self.eval(frame, expr, PREVIEW_CFG)
            except dlv.RPCError:
                return v
        return v

    def variables(self, ref):
        target = self.refs.get(ref)
        if target is None:
            raise RuntimeError("variable reference expired; the program has resumed")
        kind, frame, expr = target
        if kind == "frame":
            return self.frame_vars(frame)
        return self.children(frame, expr)

    def evaluate(self, expression, index):
        if not (0 <= index < len(self.stack)):
            return {"error": "That frame is no longer available."}
        code = re.sub(r"'(\\.|[^'])*'|\"(\\.|[^\"])*\"|`[^`]*`", "", expression)
        if re.search(r"(?<![=!<>:])=(?!=)|\+\+|--|:=", code):
            return {"error": "Watches do not change the program: assignments and ++/-- are not evaluated."}
        frame = self.stack[index][0]
        try:
            value = self.eval(frame, expression, PREVIEW_CFG)
            return {"result": self.format(value, frame, expression)}
        except dlv.RPCError as e:
            text = str(e)
            if "function call" in text or "call" in text and "not" in text:
                text = "Watches do not call functions, because that would run program code."
            return {"error": text}

    # -- commands

    def handle(self, req):
        """Handles one command while stopped. Returns the Delve command that resumes, or None."""
        seq, cmd = req.get("seq"), req.get("cmd")
        if cmd == "setBreakpoints":
            file = str(req.get("file") or "")
            respond(seq, file=file, breakpoints=self.set_breakpoints(file, req.get("lines") or []))
        elif cmd == "pause":
            respond(seq)
        elif cmd in ("continue", "stepOver", "stepIn", "stepOut"):
            respond(seq)
            if self.stop_reason == "exception":
                return "continue"
            if cmd == "stepOut" and len(self.stack) <= 1:
                return "continue"
            return {"continue": "continue", "stepOver": "next", "stepIn": "step", "stepOut": "stepOut"}[cmd]
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
        """Runs on its own thread: queues commands; while the program runs, `pause` and breakpoint changes halt it."""
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
            if req.get("cmd") == "terminate" and self.running:
                respond(req.get("seq"))
                self.kill()
                os._exit(0)
            if self.running and req.get("cmd") in ("pause", "setBreakpoints"):
                if req.get("cmd") == "pause":
                    self.pause_requested = True
                else:
                    req["_resume"] = True
                try:
                    self.side.call("Command", name="halt")
                except dlv.RPCError:
                    pass
            self.commands.put(req)
        self.kill()
        os._exit(0)

    def kill(self):
        try:
            if self.side is not None:
                self.side.call("Detach", Kill=True)
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
        self.project = dlv.Project(req.get("root") or os.getcwd(), [str(f) for f in req.get("files") or []])
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
        self.proc = dlv.start(req.get("program", "out/main"), stdin, OUT_FIFO, ERR_FIFO)
        self.client = dlv.Client()
        self.side = dlv.Client()
        for file, lines in (req.get("breakpoints") or {}).items():
            if lines:
                event("breakpoints", file=file, breakpoints=self.set_breakpoints(file, lines))

    def resume(self, command):
        """Lets the program go until it stops or ends; returns Delve's state."""
        self.running = True
        try:
            return self.client.call("Command", name=command)["State"]
        except dlv.RPCError as e:
            if "exited" in str(e) or "has exited" in str(e):
                code = re.search(r"status (-?\d+)", str(e))
                return {"exited": True, "exitStatus": int(code.group(1)) if code else 0}
            raise
        finally:
            self.running = False

    def reason(self, state):
        thread = state.get("currentThread") or {}
        bp = thread.get("breakPoint") or {}
        if bp.get("name") in ("unrecovered-panic", "runtime-fatal-throw"):
            arg = ((thread.get("breakPointInfo") or {}).get("variables") or [None])[0]
            return "exception", f"panic: {dlv.panic_message(arg)}"
        if bp.get("id", 0) > 0:
            return "breakpoint", None
        return ("pause" if self.pause_requested else "step"), None

    def run(self):
        state = self.resume("continue")
        stepping = None
        while not state.get("exited"):
            thread = state.get("currentThread") or {}
            self.gid = thread.get("goroutineID", self.gid)
            reason, description = self.reason(state)
            in_project = self.project.file(thread.get("file")) is not None
            # Commands that came in while it ran: breakpoint changes apply now.
            pending = []
            resume_after = False
            while not self.commands.empty():
                req = self.commands.get_nowait()
                if req.get("cmd") == "setBreakpoints":
                    resume_after = resume_after or req.pop("_resume", False)
                    self.safe_handle(req)
                elif req.get("cmd") == "pause":
                    respond(req.get("seq"))
                else:
                    pending.append(req)
            for req in pending:
                self.commands.put(req)
            if resume_after and not self.pause_requested and reason != "breakpoint" and reason != "exception":
                # Only a breakpoint change stopped it: carry on as before.
                state = self.resume(stepping or "continue")
                continue
            if in_project and reason == "step" and dlv.at_func_line(thread):
                state = self.resume("next")
                continue
            if not in_project and reason in ("step", "pause"):
                # In Go's own code: back to the program, or on to the end once its code is done.
                state = self.resume("stepOut" if self.frames() else "continue")
                continue
            self.pause_requested = False
            self.announce(reason, description)
            command = None
            while command is None:
                command = self.safe_handle(self.commands.get())
            event("continued")
            stepping = command if command in ("next", "step") else None
            state = self.resume(command)
        return state.get("exitStatus", 0)

    def finish(self, code):
        self.kill()
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
