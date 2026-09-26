# Code Workspace

A browser-native IDE that compiles and runs real code in isolated sandboxes. No login: open the site and start coding. Projects, run history and snapshots are stored in your browser. Execution happens in single-use Docker containers.

> "Code Workspace" is a working name, defined once in `packages/shared/src/product.ts`.

## Status

| Area | State |
| --- | --- |
| IDE shell, Monaco editor, tabs, command palette, shortcuts | Working, E2E-tested |
| Local projects (IndexedDB), autosave, reload recovery | Working, E2E-tested |
| Recent projects: listed once run or edited; projects only opened are discarded | Working, E2E-tested |
| File explorer (create, rename, move, delete, context menus) | Working, E2E-tested |
| Project search, snapshots with diff, run history | Working |
| Real execution: Java, Python, C++, C, JavaScript, TypeScript | Working. A 55-program matrix (all languages, multi-file projects, packages, errors, limits, adversarial programs) runs against Docker |
| Interactive stdin: type input while the program runs, "waiting for input" from the kernel | Working in runs and debug sessions, E2E-tested |
| Entry points: Java `main` classes (package-aware), C/C++ `main`, choice when several exist | Working, E2E-tested |
| Java debugger: breakpoints, stepping, pause, variables, watch, call stack, exception stops | Working (beta), E2E-tested against Docker |
| Python debugger: breakpoints, stepping, pause, variables, watch, call stack, exception stops | Working (beta), E2E-tested against Docker |
| Visualizer: step through a run with frames, objects and references (Python, Java) | Working (beta), tested against Docker and in the browser |

Languages: **Java 21, Python 3.13, C++ (GCC 14)** are the primary targets. C, JavaScript and TypeScript are marked *beta*.

## Architecture

```
Browser (Next.js + Monaco)
  │  HTTP  POST /api/v1/executions        ─┐
  │  WS    /ws  subscribe → live events    │
  ▼                                        │
API (NestJS)  ── validates, rate-limits ───┤
  │   BullMQ job                           │
  ▼                                        │
Redis ◄── events (Redis Streams) ── Worker (Node)
                                            │ Docker Engine API
Postgres ◄── execution records ─────────────┤
                                            ▼
                               Sandbox container (one per run)
```

```
apps/web       Next.js IDE
apps/api       NestJS HTTP + WebSocket API
apps/worker    Execution worker (BullMQ consumer, Docker sandbox)
packages/shared  Language registry, execution contract, diagnostics parsers, validation
packages/db      Prisma schema, migrations and client
```

### Debugger

Java debugging runs the real JVM under JDI/JDWP inside the same sandbox as normal runs. A small adapter (`apps/worker/debug-adapters/java/CwDebugAdapter.java`, compiled once per worker) launches your program in a second JVM over loopback and speaks JSON lines with the worker.

Python debugging runs your program in CPython under a line tracer (`sys.settrace`) from `apps/worker/debug-adapters/python/cw_debug_adapter.py`, which speaks the same JSON-lines protocol. The program keeps its own stdin, stdout and stderr, and uncaught exceptions pause on the line that raised them before the normal traceback is printed.

For both languages, commands flow browser → WebSocket → API → Redis stream → worker → adapter, and events flow back the same way.

- Breakpoints are saved with the project, follow their code as you edit, and show hollow when no code exists on that line.
- Watch expressions support variables, fields, array indexing, `.length`, arithmetic, comparisons and logic. They never call methods, so evaluating them cannot change program state.
- Python watches also support slicing, f-strings and built-ins such as `len()`, `min()`, `max()` and `sum()` on built-in values. They never call your functions, properties or `__repr__`, and objects are shown by their fields.
- Debug sessions use a separate queue and pool (`DEBUG_CONCURRENCY`, default 2), with limits of 15 minutes per session, 10 minutes idle and 30 seconds of cumulative running time while not paused. A session whose browser disconnects is stopped after 5 seconds.

### Visualizer

Visualize runs the program under a tracer in the same sandbox as a normal run and records every line: the call stack, each frame's variables and every object reachable from them, plus how much output had been printed. The browser then lets you move back and forth through the steps, drawing references as arrows.

- Python: `apps/worker/tracers/python/cw_trace.py` runs the program under `sys.settrace`.
- Java: `apps/worker/debug-adapters/java/CwTracer.java` launches the program through JDI and single-steps the main thread through the project's classes. `ArrayList`, `LinkedList`, `HashMap`, `LinkedHashMap`, `TreeMap` and sets are read from their internal fields.
- Objects are read without calling program code (no `__repr__`, properties, `toString()` or getters), so recording cannot change what the program does.
- Up to 1,000 steps and 8 MB are recorded; past that the program keeps running unrecorded and the panel says so. Typed input works while visualizing.

### Sandbox security model

User code is treated as hostile. Each execution gets a fresh container:

- no network (`NetworkMode=none`)
- runs as `nobody` (65534), all Linux capabilities dropped, `no-new-privileges`
- memory is reported (cgroup `memory.peak`) only for interpreted languages, because for compiled ones the figure would include the compiler
- read-only root filesystem; `/workspace` and `/tmp` are size-limited tmpfs, so writes count against memory
- limits: memory (no swap), CPU, PIDs (fork bombs), open files, max file size, no core dumps
- wall-clock timeouts for compile and run, an output byte cap and cancellation, each of which kills the container
- files are written as base64 arguments and commands run as argv arrays, never through shell interpolation
- the container is force-removed after every run; a startup sweep removes leftovers from crashed workers
- optional gVisor: set `SANDBOX_RUNTIME=runsc` for a user-space kernel between the program and the host

Typed input reaches the program through a FIFO. A monitor inside the sandbox reads the kernel's wait channel for each thread (`/proc/*/task/*/wchan`) to tell when the program is blocked reading stdin: a pipe read, or an epoll wait on fd 0 for Node.js. That time does not count toward the run-time limit; a single wait is capped at 5 minutes and an interactive run at 15. If prepared input is set in Program Input, it is sent whole and followed by end-of-file instead.

Debug commands and typed input are accepted only with the control token returned when the run was created (the server stores only its hash), so only the browser that started a program can drive it.

The API never runs user code. It validates requests (paths, sizes, languages), rate-limits per client (hashed IP), caps queue depth and never retries a job automatically.

## Prerequisites

- Node.js 22+ and pnpm 10+ (`npm i -g pnpm`)
- Docker Desktop (Windows/macOS) or Docker Engine (Linux). This is required for execution.
- Git

On Windows, install Docker Desktop with the WSL 2 backend. The first start downloads about 2 GB of sandbox images (JDK, GCC, Python, Node).

## Getting started

```bash
pnpm install
cp .env.example .env   # optional: every value has a local default
pnpm setup             # starts Postgres + Redis, builds packages, runs migrations
pnpm dev               # web :3000, API :4000, worker
```

Open http://localhost:3000. The status bar shows **Runner online** once the worker is connected to Docker and at least one sandbox image is ready.

### Environment variables

See `.env.example`. None are third-party credentials:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | local compose Postgres | Execution records |
| `REDIS_URL` | `redis://localhost:6379` | Queue, event streams, rate limits |
| `WEB_ORIGIN` | `http://localhost:3000` | CORS and WebSocket origin allow-list |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | API base URL for the browser |
| `WORKER_CONCURRENCY` | `2` | Parallel sandboxes per worker |
| `SANDBOX_RUNTIME` | empty (runc) | Set to `runsc` to use gVisor |
| `CLIENT_HASH_SALT` | dev value | Salt for hashing client IPs. Change it in production. |

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run web, API, worker (and rebuild shared on change) |
| `pnpm test` | Unit tests for all packages |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm test:e2e` | Playwright IDE tests (web only) |
| `E2E_EXECUTION=1 pnpm test:e2e` | Adds real execution and debugger tests in the browser (needs the full stack) |
| `E2E_EXECUTION=1 pnpm --filter @cw/worker test` | Execution matrix: real programs in every language plus adversarial programs, in Docker (needs Docker and Redis) |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop Postgres + Redis |

Playwright uses the installed Microsoft Edge by default. Set `PW_CHANNEL=chromium` after `pnpm exec playwright install chromium` to use bundled Chromium instead.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Run | `Ctrl/⌘ + Enter` |
| Visualize execution | `Ctrl/⌘ + Alt + Enter` |
| Run current file | `Ctrl/⌘ + Shift + F10`, or click the green arrow next to a `main` |
| End program input (EOF) | `Ctrl + D` in the input bar |
| Start debugging / Continue | `F5` (runs normally for languages without a debugger) |
| Stop | `Shift + F5` |
| Restart debugging | `Ctrl/⌘ + Shift + F5` |
| Toggle breakpoint | `F9`, or click left of the line numbers |
| Step over / into / out | `F10` / `F11` / `Shift + F11` |
| Pause | `F6` |
| Debug panel | `Ctrl/⌘ + Shift + D` |
| Command palette | `Ctrl/⌘ + Shift + P` |
| Go to file | `Ctrl/⌘ + P` |
| Save (autosave is always on) | `Ctrl/⌘ + S` |
| Find / Replace | `Ctrl/⌘ + F` / `Ctrl/⌘ + H` |
| Toggle sidebar / panel | `Ctrl/⌘ + B` / `Ctrl/⌘ + J` |
| Search in project | `Ctrl/⌘ + Shift + F` |
| Problems | `Ctrl/⌘ + Shift + M` |

## Production

Production runs on one Docker-capable Linux server with Docker Compose: Caddy
(automatic HTTPS, static IDE, `/api` and `/ws` proxy), the API, the execution
worker, Redis and Postgres. Only Caddy publishes ports. See
[deploy/README.md](deploy/README.md) for the server setup, DNS records,
deployments with automatic rollback, health checks and the security model.

`node deploy/smoke.mjs https://<host>` runs real and hostile programs through a
deployed site's public HTTPS API and WebSocket. CI (`.github/workflows/ci.yml`)
runs lint, typecheck, unit tests, the build, the Docker execution matrix and the
production image build on every push.

## Known limitations

- **C/C++ debugging** is not available: it needs a native debugger (GDB) integration, which does not exist yet. The Debug button is hidden for those languages.
- **Threads:** the Python debugger follows the main thread only; the Java debugger pauses all threads but shows the stopped thread's stack.
- **TypeScript imports** must name the file with its extension (`./cart.ts`), as Node.js requires. There is no bundler or `tsconfig` path mapping.
- **C/C++ include paths:** headers are found relative to the including file (standard compiler behaviour); there is no project build file or `-I` configuration yet.
- **Several `main` methods in one Java file:** the class named after the file runs; entry points are chosen per file.
- **Input-wait detection** relies on the kernel exposing wait channels. Where it does not, input waits count as run time within the 15-minute interactive cap.

## Troubleshooting

- **"Runner offline"**: the API isn't reachable. Check that `pnpm dev` is running and port 4000 is free.
- **"Runner unavailable: No execution worker is running"**: start the worker (`pnpm --filter @cw/worker dev`).
- **"Docker is not reachable from the worker"**: start Docker Desktop. On Linux, make sure your user can access `/var/run/docker.sock`.
- **"Downloading sandbox images"**: the first start pulls images. Watch the worker log. Languages become available as their image finishes.
- **Execution is slow the first time**: the JVM and GCC have cold-start costs. Later runs reuse cached images.
- **Postgres or Redis port conflicts**: another local instance is using 5432/6379. Stop it, or change the ports in `docker-compose.yml` and `.env`.
