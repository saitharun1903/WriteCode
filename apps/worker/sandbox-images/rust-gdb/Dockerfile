# The Rust sandbox image with gdb, for the debugger and the visualizer.
# Normal runs use rust:1.90-slim itself; this adds gdb (with its Python) and
# makes Rust's own gdb pretty printers (Vec, String, HashMap...) easy to find.
FROM rust:1.90-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gdb \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(rustc --print sysroot)/lib/rustlib/etc" /opt/rust-gdb
