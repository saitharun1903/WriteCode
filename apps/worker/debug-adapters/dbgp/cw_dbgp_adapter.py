"""Code Workspace PHP debug adapter, driving Xdebug.

Speaks newline-delimited JSON on stdin/stdout, the same protocol as the other
adapters:

  in : {"seq":1,"cmd":"launch", ...} | continue | pause | stepOver | stepIn | stepOut
       | setBreakpoints | variables | evaluate | terminate
  out: {"type":"response","requestSeq":1,...} | {"type":"event","event":"stopped",...}

PHP runs under Xdebug with its own stdin (the input file or the typed-input
FIFO); its stdout and stderr go through FIFOs and are relayed as "output"
events. An exception stops the program where it is thrown, with its class
and message. Watch expressions are checked first: variables, their fields and
elements, arithmetic and comparisons, and a few built-in functions that only
read (count, strlen...); nothing that assigns or calls the program's code.
"""

import json
import os
import queue
import re
import sys
import threading

sys.path.insert(0, "/tmp/cwdbg")
import cw_dbgp as dbgp  # noqa: E402

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


def quote(fullname):
    return '"' + fullname.replace("\\", "\\\\").replace('"', '\\"') + '"'


# ------------------------------------------------------------------ values


def preview(p, depth=0):
    """Short text: `3`, `"ada"`, `[3, 1, 2]`, `["ada" => 36]`, `Node {value: 1, next: Node {…}}`, `null`."""
    text = dbgp.scalar(p)
    if text is not None:
        return text if depth == 0 or len(text) <= 60 else text[:60] + "…"
    t = p.get("type")
    kids = dbgp.children(p)
    total = int(p.get("numchildren") or len(kids))
    more = ", …" if total > min(len(kids), PREVIEW_ITEMS) else ""
    if t == "array":
        if depth > 1 or (total and not kids):
            return "[…]"
        if dbgp.is_list(p):
            return "[" + ", ".join(preview(k, depth + 1) for k in kids[:PREVIEW_ITEMS]) + more + "]"
        return "[" + ", ".join(f"{dbgp.key_text(k)} => {preview(k, depth + 1)}" for k in kids[:PREVIEW_ITEMS]) + more + "]"
    if t == "object":
        cls = p.get("classname") or "object"
        if depth > 1 or (total and not kids):
            return f"{cls} {{…}}"
        return f"{cls} {{" + ", ".join(f"{dbgp.name_of(k)}: {preview(k, depth + 1)}" for k in kids[:PREVIEW_ITEMS]) + more + "}"
    return dbgp.text_of(p) or t or "?"


# Built-in functions a watch may call: they only read what they are given.
READERS = {
    "count", "strlen", "abs", "max", "min", "intdiv", "round", "floor", "ceil", "sqrt", "pow", "is_null", "isset", "empty",
    "array_key_exists", "in_array", "array_sum", "array_keys", "array_values", "strtoupper", "strtolower", "implode", "str_repeat",
    "substr", "strrev", "is_int", "is_string", "is_array", "gettype", "array_slice", "trim", "ord", "chr", "mb_strlen",
}
TOKEN = re.compile(r"""\s+|\$[A-Za-z_]\w*|->[A-Za-z_]\w*|\d+(?:\.\d+)?|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\$])*"|===|!==|==|!=|<=>|<=|>=|&&|\|\||\?\?|[A-Za-z_]\w*\s*\(|[A-Za-z_]\w*|[-+*/%.<>!?:(),\[\]]""")
WORDS = {"true", "false", "null", "and", "or", "xor", "instanceof"}


def checked(expression):
    """None when the watch only reads; otherwise why it is not evaluated."""
    pos = 0
    text = expression.strip()
    if re.search(r"(?<![=!<>])=(?![=>])|\+\+|--", re.sub(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"", "", text)):
        return "Watches do not change the program: assignments and ++/-- are not evaluated."
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            return f"'{text[pos:pos + 10]}' is not supported in watches"
        tok = m.group(0)
        pos = m.end()
        if tok.endswith("(") and re.match(r"[A-Za-z_]", tok):
            name = tok[:-1].strip()
            if name.lower() not in READERS:
                return "Watches do not call functions, because that would run program code."
        elif re.fullmatch(r"[A-Za-z_]\w*", tok) and tok.lower() not in WORDS:
            return f"'{tok}' is not supported in watches"
    return None


PATH = re.compile(r"\$[A-Za-z_]\w*(?:->[A-Za-z_]\w*|\[(?:-?\d+|'[^']*'|\"[^\"$]*\")\])*")


# ------------------------------------------------------------------ adapter


class Adapter:
    def __init__(self):
        self.project = dbgp.Project("/", [])
        self.session = None
        self.breakpoints = {}  # file -> {line: breakpoint id}
        self.refs = {}
        self.next_ref = 1
        self.stack = []  # (level, stack element) of the program's frames, innermost first
        self.commands = queue.Queue()
        self.running = False
        self.pause_requested = False
        self.stop_reason = None
        self.pumps = []
        self.lock = threading.Lock()

    # -- breakpoints

    def set_breakpoints(self, file, lines):
        lines = sorted({int(n) for n in lines})
        for bid in self.breakpoints.pop(file, {}).values():
            try:
                self.session.call(f"breakpoint_remove -d {bid}")
            except dbgp.DBGpError:
                pass
        placed = {}
        result = []
        for line in lines:
            ok = False
            # A line with no code moves to the next one that has some: say which, so the editor shows it there.
            for at in range(line, line + 30) if file in self.project.files else []:
                try:
                    reply = self.session.call(f"breakpoint_set -t line -f {quote(self.project.uri(file))} -n {at}")
                except dbgp.DBGpError:
                    continue
                bid = reply.get("id")
                if reply.get("resolved") == "unresolved":
                    try:
                        self.session.call(f"breakpoint_remove -d {bid}")
                    except dbgp.DBGpError:
                        pass
                    continue
                actual = at
                try:
                    got = self.session.call(f"breakpoint_get -d {bid}").find(dbgp.NS + "breakpoint")
                    actual = int(got.get("lineno") or at) if got is not None else at
                except (dbgp.DBGpError, ValueError):
                    pass
                placed[line] = bid
                result.append({"line": line, "verified": True, "actual": actual})
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
            stack = [s for s in self.session.call("stack_get") if s.tag == dbgp.NS + "stack"]
        except dbgp.DBGpError:
            return []
        return [(int(s.get("level") or 0), s) for s in stack if self.project.file(s.get("filename"))]

    def announce(self, reason, description):
        self.stack = self.frames()
        self.refs.clear()
        self.next_ref = 1
        self.stop_reason = reason
        frames = [
            {"id": n, "name": dbgp.frame_name(s.get("where")), "file": self.project.file(s.get("filename")), "line": int(s.get("lineno") or 0), "localsRef": self.register(("frame", level, None))}
            for n, (level, s) in enumerate(self.stack)
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

    def format(self, p, level):
        expandable = int(p.get("numchildren") or 0) > 0 and p.get("fullname")
        d = {"value": clip(preview(p)), "type": p.get("classname") or p.get("type") or "", "ref": self.register(("value", level, p.get("fullname"))) if expandable else 0}
        if p.get("type") == "array":
            d["length"] = int(p.get("numchildren") or 0)
        return d

    def describe(self, name, p, level):
        d = self.format(p, level)
        d["name"] = name
        return d

    def property(self, level, fullname, depth=1):
        self.session.call(f"feature_set -n max_depth -v {depth}")
        reply = self.session.call(f"property_get -d {level} -n {quote(fullname)}")
        return reply.find(dbgp.NS + "property")

    def variables(self, ref):
        target = self.refs.get(ref)
        if target is None:
            raise RuntimeError("variable reference expired; the program has resumed")
        kind, level, fullname = target
        if kind == "frame":
            self.session.call("feature_set -n max_depth -v 2")
            props = [p for p in self.session.call(f"context_get -d {level} -c 0") if p.tag == dbgp.NS + "property"]
            return [self.describe(p.get("name") or "?", p, level) for p in props if p.get("type") != "uninitialized"][:MAX_CHILDREN]
        p = self.property(level, fullname, 2)
        if p is None:
            return []
        kids = dbgp.children(p)
        out = []
        for k in kids:
            name = f"[{dbgp.key_text(k)}]" if p.get("type") == "array" else dbgp.name_of(k)
            out.append(self.describe(name, k, level))
        total = int(p.get("numchildren") or len(kids))
        if total > len(kids):
            out.append({"name": "…", "value": f"{total - len(kids)} more", "type": "", "ref": 0})
        return out

    def evaluate(self, expression, index):
        if not (0 <= index < len(self.stack)):
            return {"error": "That frame is no longer available."}
        level = self.stack[index][0]
        expr = expression.strip()
        if PATH.fullmatch(expr):
            # A variable, or a field or element of one: read without evaluating anything, in any frame.
            try:
                p = self.property(level, expr, 2)
                return {"result": self.format(p, level)} if p is not None else {"error": f"{expr} is not defined"}
            except dbgp.DBGpError as e:
                return {"error": f"{expr} is not defined" if "can not get" in str(e) else str(e)}
        problem = checked(expr)
        if problem:
            return {"error": problem}
        if level != 0:
            return {"error": "Expressions are evaluated in the innermost frame; in this frame, watch a variable or one of its fields."}
        try:
            self.session.call("feature_set -n max_depth -v 2")
            p = self.session.call("eval", expr).find(dbgp.NS + "property")
            return {"result": self.format(p, level)} if p is not None else {"error": "no value"}
        except dbgp.DBGpError as e:
            return {"error": str(e)}

    # -- commands

    def handle(self, req):
        """Handles one command while stopped. Returns the DBGp command that resumes, or None."""
        seq, cmd = req.get("seq"), req.get("cmd")
        if cmd == "setBreakpoints":
            file = str(req.get("file") or "")
            respond(seq, file=file, breakpoints=self.set_breakpoints(file, req.get("lines") or []))
        elif cmd == "pause":
            respond(seq)
        elif cmd in ("continue", "stepOver", "stepIn", "stepOut"):
            respond(seq)
            if cmd == "stepOut" and len(self.stack) <= 1:
                return "run"
            return {"continue": "run", "stepOver": "step_over", "stepIn": "step_into", "stepOut": "step_out"}[cmd]
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
        """Runs on its own thread: queues commands; while the program runs, `pause` and breakpoint changes interrupt it."""
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
                    with self.lock:
                        self.session.send("break")
                except OSError:
                    pass
            self.commands.put(req)
        self.kill()
        os._exit(0)

    def kill(self):
        if self.session is not None:
            try:
                self.session.proc.kill()
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
        self.project = dbgp.Project(req.get("root") or os.getcwd(), [str(f) for f in req.get("files") or []])
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
        self.session = dbgp.Session(req["entry"], stdin, OUT_FIFO, ERR_FIFO)
        for name, value in (("max_depth", "2"), ("max_children", str(MAX_CHILDREN)), ("max_data", "500"), ("resolved_breakpoints", "1")):
            self.session.call(f"feature_set -n {name} -v {value}")
        # An exception stops where it is thrown (Exception and Error cover every class PHP throws); a warning does not.
        for name in ("Exception", "Error"):
            self.session.call(f'breakpoint_set -t exception -x "{name}"')
        for file, lines in (req.get("breakpoints") or {}).items():
            if lines:
                event("breakpoints", file=file, breakpoints=self.set_breakpoints(file, lines))

    def resume(self, command):
        """Lets the program go until it stops or ends; returns Xdebug's reply, or None once the program has ended."""
        self.running = True
        try:
            with self.lock:
                tid = self.session.send(command)
            reply = self.session.wait(tid)
        except (EOFError, OSError):
            return None
        finally:
            self.running = False
        return None if reply.get("status") in ("stopping", "stopped") else reply

    def run(self):
        reply = self.resume("run")
        stepping = None
        last = "run"
        while reply is not None:
            uri, line, exception, message = dbgp.message_of(reply)
            in_project = self.project.file(uri) is not None
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
            if exception:
                reason, description = "exception", f"{exception}: {message}" if message else exception
            elif self.pause_requested:
                reason, description = "pause", None
            elif resume_after:
                # Only a breakpoint change stopped it: carry on as before.
                reply = self.resume(stepping or "run")
                continue
            else:
                reason, description = ("breakpoint" if last == "run" else "step"), None
            if not in_project and reason in ("step", "pause"):
                reply = self.resume("step_out" if self.frames() else "run")
                continue
            self.pause_requested = False
            self.announce(reason, description)
            command = None
            while command is None:
                command = self.safe_handle(self.commands.get())
            event("continued")
            stepping = command if command in ("step_over", "step_into") else None
            last = command
            reply = self.resume(command)
        try:
            self.session.conn.close()
        except OSError:
            pass
        try:
            return self.session.proc.wait(timeout=10)
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
