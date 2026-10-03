"""Xdebug, for the PHP debugger and tracer: start PHP under it, talk DBGp, read PHP values.

Xdebug connects back to this process on a local port and answers DBGp
commands. This module is shared by cw_dbgp_adapter.py (the debugger) and
cw_trace_dbgp.py (the visualizer's tracer).
"""

import base64
import json
import os
import re
import socket
import subprocess
import xml.etree.ElementTree as ET

PORT = 9003
NS = "{urn:debugger_protocol_v1}"
XDEBUG_NS = "{https://xdebug.org/dbgp/xdebug}"


class DBGpError(Exception):
    pass


class Session:
    """PHP running under Xdebug, connected to this process."""

    def __init__(self, entry, stdin, out, err):
        self.server = socket.socket()
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(("127.0.0.1", PORT))
        self.server.listen(1)
        self.server.settimeout(20)
        self.proc = subprocess.Popen(
            ["php", "-d", "zend_extension=xdebug", "-d", "xdebug.mode=debug", "-d", "xdebug.start_with_request=yes",
             "-d", "xdebug.client_host=127.0.0.1", "-d", f"xdebug.client_port={PORT}", "-d", "xdebug.log_level=0",
             "-d", "display_errors=stderr", "-d", "log_errors=0", entry],
            stdin=open(stdin, "rb"), stdout=open(out, "wb", buffering=0), stderr=open(err, "wb", buffering=0),
        )
        self.conn, _ = self.server.accept()
        self.buffer = b""
        self.next_id = 0
        self.init = self.packet()

    def packet(self):
        while True:
            if b"\0" in self.buffer:
                size, rest = self.buffer.split(b"\0", 1)
                n = int(size)
                if len(rest) >= n + 1:
                    body, self.buffer = rest[:n], rest[n + 1:]
                    return ET.fromstring(body)
            data = self.conn.recv(65536)
            if not data:
                raise EOFError("PHP ended")
            self.buffer += data

    def send(self, command, data=None):
        """Sends a command without waiting; returns its transaction id."""
        self.next_id += 1
        line = f"{command} -i {self.next_id}" + (" -- " + base64.b64encode(data.encode()).decode() if data is not None else "")
        self.conn.sendall(line.encode() + b"\0")
        return self.next_id

    def wait(self, tid):
        while True:
            reply = self.packet()
            if reply.get("transaction_id") == str(tid):
                return reply

    def call(self, command, data=None):
        reply = self.wait(self.send(command, data))
        error = reply.find(NS + "error")
        if error is not None:
            message = error.find(NS + "message")
            raise DBGpError(message.text if message is not None and message.text else f"error {error.get('code')}")
        return reply


def message_of(reply):
    """Where a run or step stopped, and the exception it stopped on: (file uri, line, exception or None, its message)."""
    m = reply.find(XDEBUG_NS + "message")
    if m is None:
        return None, 0, None, None
    return m.get("filename"), int(m.get("lineno") or 0), m.get("exception"), (m.text or "").strip()


class Project:
    def __init__(self, root, files):
        self.root = os.path.normpath(root)
        self.files = set(files)

    def file(self, uri):
        if not uri:
            return None
        path = os.path.normpath(re.sub(r"^file://", "", uri))
        if not path.startswith(self.root + "/"):
            return None
        rel = path[len(self.root) + 1:]
        return rel if rel in self.files else None

    def uri(self, file):
        return "file://" + os.path.join(self.root, file)


def frame_name(where):
    """`{main}` reads `<main>`; methods keep PHP's `Node->push` and `Stack::create`."""
    return "<main>" if where in ("{main}", None, "") else where


# ------------------------------------------------------------------ values


def text_of(p):
    raw = p.text or ""
    if p.get("encoding") == "base64" and raw:
        try:
            return base64.b64decode(raw).decode("utf-8", "replace")
        except ValueError:
            return raw
    return raw


def children(p):
    return p.findall(NS + "property")


def name_of(p):
    """A variable without its `$`; an object's field by its name."""
    name = p.get("name") or ""
    return name[1:] if name.startswith("$") else name


def scalar(p):
    """The text of a value that is not an array or object, as PHP writes it; None for those."""
    t = p.get("type")
    if t == "string":
        s = text_of(p)
        size = int(p.get("size") or len(s))
        return json.dumps(s + ("…" if size > len(s) else ""), ensure_ascii=False)
    if t == "bool":
        return "true" if (p.text or "0") == "1" else "false"
    if t == "null":
        return "null"
    if t in ("int", "float"):
        return text_of(p)
    if t == "uninitialized":
        return "uninitialized"
    if t == "resource":
        return text_of(p) or "resource"
    return None


def is_list(p):
    """An array whose keys are 0, 1, 2...: drawn as a list, not as a table of keys."""
    kids = children(p)
    return all(k.get("name") == str(i) for i, k in enumerate(kids))


def key_text(p):
    name = p.get("name") or ""
    return name if re.fullmatch(r"-?\d+", name) else json.dumps(name, ensure_ascii=False)
