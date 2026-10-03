"""Bash, for the debugger and tracer: start the script under the prelude, read what it reports.

The prelude (cw_bash_prelude.sh) runs the script with a DEBUG trap and writes
blocks to a FIFO: the stop, the call stack, then `declare -p` of the script's
variables. This module starts Bash, reads those blocks, and reads `declare -p`
back into values: strings, integers (`declare -i`), indexed arrays and
associative arrays.
"""

import os
import re
import subprocess

EVENTS = "/tmp/cw-bash-events"
COMMANDS = "/tmp/cw-bash-commands"
BREAKPOINTS = "/tmp/cw-bash-breakpoints"


def start(prelude, entry, files, mode, stdin, out, err):
    """Starts the script under the prelude; returns (process, events file, commands file)."""
    for path in (EVENTS, COMMANDS):
        if not os.path.exists(path):
            os.mkfifo(path)
    env = dict(os.environ, CW_MODE=mode, CW_FILES=" ".join(files), CW_EVENTS=EVENTS, CW_COMMANDS=COMMANDS, CW_BREAKPOINTS=BREAKPOINTS)
    proc = subprocess.Popen(["bash", "--noprofile", "--norc", prelude, entry], env=env,
                            stdin=open(stdin, "rb"), stdout=open(out, "wb", buffering=0), stderr=open(err, "wb", buffering=0))
    events = open(EVENTS, "r", encoding="utf-8", errors="replace")
    commands = open(COMMANDS, "w", encoding="utf-8")
    return proc, events, commands


def read_block(events):
    """The next report: ("step", {reason, file, line, depth, frames, variables}) or ("exception", {file, line, command}), or None at the end."""
    while True:
        line = events.readline()
        if not line:
            return None
        line = line.rstrip("\n")
        if line.startswith("EXC "):
            parts = line.split(" ", 3)
            return "exception", {"file": parts[1], "line": int(parts[2]), "command": parts[3] if len(parts) > 3 else ""}
        if not line.startswith("STEP "):
            continue
        _, reason, file, number, depth = line.split(" ", 4)
        frames = []
        declare = []
        while True:
            row = events.readline()
            if not row or row == "END\n":
                break
            if row.startswith("F ") and not declare:
                parts = row.rstrip("\n").split(" ")
                frames.append({"name": parts[1], "file": parts[2], "line": int(parts[3])})
            else:
                declare.append(row)
        return "step", {"reason": reason, "file": file, "line": int(number), "depth": int(depth), "frames": frames, "variables": parse_declare("".join(declare))}


# ------------------------------------------------------------------ declare -p


def _word(text, i):
    """A shell word as `declare -p` writes it, from text[i]: "double quoted", $'ansi', or bare. Returns (value, next index)."""
    out = []
    n = len(text)
    while i < n and text[i] not in " \n)=":
        c = text[i]
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n and text[i + 1] in '"\\$`\n':
                    out.append(text[i + 1])
                    i += 2
                    continue
                out.append(text[i])
                i += 1
            i += 1
        elif c == "$" and i + 1 < n and text[i + 1] == "'":
            i += 2
            while i < n and text[i] != "'":
                if text[i] == "\\" and i + 1 < n:
                    esc = text[i + 1]
                    out.append({"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"', "e": "\x1b", "a": "\a", "b": "\b"}.get(esc, esc))
                    i += 2
                    continue
                out.append(text[i])
                i += 1
            i += 1
        elif c == "'":
            i += 1
            while i < n and text[i] != "'":
                out.append(text[i])
                i += 1
            i += 1
        elif c == "\\" and i + 1 < n:
            out.append(text[i + 1])
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out), i


def parse_declare(text):
    """[(name, kind, value)]: kind is `string`, `integer`, `array` (value: {index: text}) or `assoc` (value: {key: text})."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        m = re.compile(r"declare -(\S+) ([A-Za-z_]\w*)").match(text, i)
        if not m:
            nl = text.find("\n", i)
            i = n if nl < 0 else nl + 1
            continue
        flags, name = m.group(1), m.group(2)
        i = m.end()
        kind = "assoc" if "A" in flags else "array" if "a" in flags else "integer" if "i" in flags else "string"
        if i < n and text[i] == "=":
            i += 1
            if kind in ("array", "assoc") and i < n and text[i] == "(":
                i += 1
                items = {}
                while i < n and text[i] != ")":
                    if text[i] in " \n":
                        i += 1
                        continue
                    if text[i] != "[":
                        break
                    j = i + 1
                    key, j = _word(text, j) if text[j] != "]" else ("", j)
                    # The key ends at the closing bracket.
                    close = text.find("]=", j - 1 if text[j - 1] == "]" else j)
                    if close < 0:
                        break
                    if not key or text[close - 1:close] != key[-1:] and "[" not in key:
                        key = text[i + 1:close]
                        key, _ = _word(key, 0) if key[:1] in "\"$'" else (key, 0)
                    value, i = _word(text, close + 2)
                    items[key] = value
                value = items
                if i < n and text[i] == ")":
                    i += 1
            else:
                value, i = _word(text, i)
        else:
            value = {} if kind in ("array", "assoc") else None  # declared, not set
        out.append((name, kind, value))
        nl = text.find("\n", i)
        i = n if nl < 0 else nl + 1
    return out


def is_number(s):
    return re.fullmatch(r"-?\d+", s or "") is not None


def text_of(kind, value):
    """A scalar as the debugger shows it: a number bare, other text in quotes."""
    if value is None:
        return "(unset)"
    if kind == "integer" or is_number(value):
        return value
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
