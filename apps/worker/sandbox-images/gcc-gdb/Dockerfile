# The C/C++ sandbox image with gdb, for the debugger and the visualizer.
# Normal runs use gcc:14 itself; this only adds gdb (with its Python) on top.
FROM gcc:14
RUN apt-get update \
 && apt-get install -y --no-install-recommends gdb \
 && rm -rf /var/lib/apt/lists/*
