"""What the gdb debugger and tracer need to know about Rust.

Loaded by cw_gdb_adapter.py and cw_trace_gdb.py when the program is Rust.
gdb reads Rust on its own; this adds Rust's pretty printers (Vec, String,
HashMap... from the toolchain), names as a Rust programmer writes them
(`Vec<i32>`, `Node::new`), the values gdb has no printer for (Option and
other enums, tuples, char, references), and where a panic stops the program.
"""

import os
import re
import sys

import gdb

# The toolchain's gdb printers (the image links them here).
PRINTERS_DIR = "/opt/rust-gdb"
# Called once a panic's message is printed, before the stack unwinds: where the debugger and the tracer stop.
PANIC_SYMBOL = "std::panicking::rust_panic"

_sources = {}


def setup():
    """Rust's printers, and stepping that stays out of the standard library."""
    if os.path.isdir(PRINTERS_DIR) and PRINTERS_DIR not in sys.path:
        sys.path.insert(0, PRINTERS_DIR)
    try:
        import gdb_lookup

        gdb_lookup.register_printers(gdb.current_progspace())
    except Exception:  # noqa: BLE001 - values then show as gdb prints them
        pass
    for cmd in ("skip -rfu ^(core|alloc|std|hashbrown|compiler_builtins)::", "skip -gfi /rustc/**"):
        try:
            gdb.execute(cmd, to_string=True)
        except gdb.error:
            pass


def crate_of(entry):
    """rustc names the crate after the file: `main.rs` is the crate `main`."""
    return re.sub(r"[^A-Za-z0-9_]", "_", os.path.splitext(os.path.basename(entry))[0])


def source_lines(path):
    if path not in _sources:
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                _sources[path] = fh.read().split("\n")
        except OSError:
            _sources[path] = []
    return _sources[path]


# ------------------------------------------------------------------ names

_PATH = re.compile(r"\b(?:[a-z_][a-z0-9_]*::)+(?=[A-Za-z_(])")


def type_name(s):
    """`alloc::vec::Vec<i32, alloc::alloc::Global>` reads `Vec<i32>`; `main::Node` reads `Node`; `*mut i32` reads `&i32`."""
    s = re.sub(r",\s*(?:alloc::alloc::Global|std::hash::random::RandomState)\b", "", s)
    s = _PATH.sub("", s)
    s = re.sub(r"\*(?:mut|const) ", "&", s)
    return re.sub(r"\s+>", ">", s)


def frame_name(name, frame):
    """`main::square` reads `square`; a method, `main::{impl#0}::new`, reads `Node::new` (its impl block names the type)."""
    parts = name.split("::")
    if len(parts) > 1:
        parts = parts[1:]  # the crate
    out = []
    for p in parts:
        m = re.fullmatch(r"\{impl#\d+\}", p)
        if m:
            out.append(impl_type(frame) or "impl")
        else:
            out.append(p)
    return "::".join(out)


def impl_type(frame):
    """The type of the impl block a method is written in, read from the source above it."""
    try:
        fn = frame.function()
        path = fn.symtab.fullname()
        line = fn.line
    except (AttributeError, gdb.error, RuntimeError):
        return None
    lines = source_lines(path)
    for i in range(min(line, len(lines)) - 1, -1, -1):
        m = re.match(r"\s*impl\b(?:\s*<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_]\w*)", lines[i])
        if m:
            return m.group(1)
    return None


def hidden(sym):
    """Variables the compiler adds: a for loop's iterator is named `iter`, on the line of the loop."""
    if sym.name.startswith("__") or sym.name.startswith("$"):
        return True
    if sym.name != "iter":
        return False
    try:
        lines = source_lines(sym.symtab.fullname())
        return lines[sym.line - 1].lstrip().startswith("for ")
    except (AttributeError, IndexError, gdb.error, RuntimeError):
        return False


# ------------------------------------------------------------------ values


def is_enum(t):
    """A Rust enum: gdb gives it a hidden discriminant as its first field, then one field per variant."""
    try:
        fields = t.fields()
    except (TypeError, gdb.error):
        return False
    return t.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION) and len(fields) > 0 and getattr(fields[0], "artificial", False)


def variant(v):
    """(variant name, its value or None) of an enum value, as gdb reads its discriminant."""
    t = v.type.strip_typedefs()
    try:
        text = v.format_string(max_depth=1, max_elements=1, raw=True)
    except gdb.error:
        return None, None
    prefix = str(t) + "::"
    rest = text[len(prefix):] if text.startswith(prefix) else text.split("::")[-1]
    name = re.match(r"[A-Za-z_]\w*", rest)
    if not name:
        return None, None
    name = name.group(0)
    for f in t.fields()[1:]:
        if f.name == name:
            try:
                return name, v[f]
            except gdb.error:
                return name, None
    return name, None


def variant_fields(value):
    """(name, value) of a variant's data: `0`, `1` for a tuple variant, field names for a struct variant."""
    out = []
    try:
        fields = value.type.strip_typedefs().fields()
    except (AttributeError, TypeError, gdb.error):
        return out
    for f in fields:
        if getattr(f, "artificial", False) or not f.name:
            continue
        try:
            out.append((re.sub(r"^__(\d+)$", r"\1", f.name), value[f]))
        except gdb.error:
            continue
    return out


def is_tuple(t):
    return t.code == gdb.TYPE_CODE_STRUCT and str(t).startswith("(")


def is_option(t):
    return re.match(r"core::option::Option<", str(t)) is not None


def char_text(v):
    try:
        n = int(v)
    except (gdb.error, ValueError):
        return "?"
    special = {0: "'\\0'", 9: "'\\t'", 10: "'\\n'", 13: "'\\r'", 39: "'\\''", 92: "'\\\\'"}
    if n in special:
        return special[n]
    try:
        return f"'{chr(n)}'"
    except ValueError:
        return str(n)


def is_char(t):
    return t.code == gdb.TYPE_CODE_CHAR


def scalar_target(t):
    """A reference to a number, bool or char: shown as the value it refers to."""
    target = t.target().strip_typedefs()
    return target.code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_FLT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_CHAR)


def short_type(v):
    return type_name(str(v.type.strip_typedefs()))
