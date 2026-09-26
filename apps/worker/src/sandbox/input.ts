import type { Redis } from "ioredis";
import { REQUEST_BOUNDS, STREAM_FIELD, redisKeys, utf8ByteLength } from "@cw/shared";
import type { InteractiveProcess, Sandbox } from "./sandbox.js";

/** FIFO the program reads as its stdin in interactive runs. */
export const INPUT_FIFO = "/tmp/cw-in";
/** Count of input chunks the feeder has written into the FIFO. */
const INPUT_SEQ = "/tmp/cw-in-seq";

/**
 * Holds the FIFO's write end and appends typed input to it. Each line on the
 * feeder's stdin is one base64 chunk; the line `EOF` closes the write end so
 * the program sees end-of-file. (Docker's Windows named-pipe transport cannot
 * half-close a hijacked stream, so EOF has to be an explicit message.) After
 * each chunk it records how many chunks it has written.
 */
const FEEDER_SCRIPT = `exec 3>${INPUT_FIFO}
n=0
while IFS= read -r l; do
  [ "$l" = EOF ] && exit 0
  printf %s "$l" | base64 -d >&3 || exit 0
  n=$((n+1)); echo "$n" > ${INPUT_SEQ}
done`;

/**
 * Reports "<waiting> <seq>" on change. <waiting> is 1 while a process whose
 * stdin is the FIFO is blocked waiting for it: a thread's kernel wait channel
 * is a pipe read (Java, Python, C/C++), or an epoll wait whose interest set
 * includes fd 0 (Node.js and other event loops). <seq> is the feeder's chunk
 * count read before the scan: a reader blocked on an empty pipe has consumed
 * every chunk up to <seq>, so a wait with seq >= chunks sent is a new wait
 * even when the program blocked again between two polls. Prints
 * "unsupported" when the kernel does not expose wait channels. Shell builtins
 * only, apart from one sleep per poll.
 */
const MONITOR_SCRIPT = `F=${INPUT_FIFO}
polls_stdin() {
  for f in "$1"/fdinfo/*; do
    while read -r a b rest; do
      if [ "$a" = "tfd:" ] && [ "$b" = 0 ]; then return 0; fi
    done 2>/dev/null < "$f"
  done
  return 1
}
w1=; read -r w1 2>/dev/null < /proc/1/wchan
case "$w1" in ""|0) echo unsupported; exit 0;; esac
last=
while :; do
  s=0; read -r s 2>/dev/null < ${INPUT_SEQ}
  w=0
  for t in /proc/[0-9]*/task/[0-9]*; do
    # wchan has no trailing newline, so read "fails" at EOF after filling c; test c instead.
    c=; read -r c 2>/dev/null < "$t/wchan"
    [ -n "$c" ] || continue
    case "$c" in
      *pipe*) p=\${t%/task/*}; if [ "$p/fd/0" -ef "$F" ]; then w=1; break; fi;;
      *ep_poll*|*epoll*) p=\${t%/task/*}; if [ "$p/fd/0" -ef "$F" ] && polls_stdin "$p"; then w=1; break; fi;;
    esac
  done
  if [ "$w $s" != "$last" ]; then echo "$w $s"; last="$w $s"; fi
  sleep 0.1
done`;

export interface InputChannelEvents {
  /** The program started or stopped waiting for input. */
  onWaiting: (waiting: boolean) => void;
  /** Input accepted for the program, echoed to the console. */
  onEcho: (text: string) => void;
}

/**
 * Interactive stdin for one sandboxed program: a FIFO, a feeder that writes
 * typed input into it, and a monitor that tells when the program is blocked
 * reading it. Create the FIFO before starting the program; the program's
 * open() and the feeder's open() complete together.
 */
export class InputChannel {
  waiting = false;
  /** False when the kernel does not report wait channels; waits then count as run time. */
  detection = true;
  private closed = false;
  private bytes = 0;
  /** Chunks handed to the feeder. */
  private sent = 0;

  private constructor(
    private readonly feeder: InteractiveProcess,
    private readonly events: InputChannelEvents,
  ) {}

  static async createFifo(sandbox: Sandbox): Promise<void> {
    await sandbox.exec(["mkfifo", "-m", "600", INPUT_FIFO]);
  }

  /**
   * Starts the feeder and, unless `monitor` is false (the caller then calls
   * `reportWaiting` from its own source), the wait-channel monitor.
   */
  static async start(sandbox: Sandbox, events: InputChannelEvents, { monitor = true } = {}): Promise<InputChannel> {
    const feeder = await sandbox.startInteractive(["sh", "-c", FEEDER_SCRIPT], { onStdout: () => {}, onStderr: () => {} });
    const channel = new InputChannel(feeder, events);
    if (!monitor) return channel;
    let buffer = "";
    await sandbox.startInteractive(["sh", "-c", MONITOR_SCRIPT], {
      onStdout: (chunk) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line === "unsupported") {
            channel.detection = false;
            continue;
          }
          const [w, seq] = line.split(" ").map(Number);
          // A wait observed before the latest input reached the FIFO is stale.
          if (w === 0 || w === 1) channel.reportWaiting(w === 1 && (seq ?? 0) >= channel.sent);
        }
      },
      onStderr: () => {},
    });
    return channel;
  }

  reportWaiting(waiting: boolean) {
    if (waiting === this.waiting || this.closed) return;
    this.waiting = waiting;
    this.events.onWaiting(waiting);
  }

  /** Forwards typed input. Returns an error message when it cannot be accepted. */
  send(text: string): string | null {
    if (this.closed) return "Input is closed.";
    const size = utf8ByteLength(text);
    if (this.bytes + size > REQUEST_BOUNDS.maxStdinBytes) return `Input is limited to ${REQUEST_BOUNDS.maxStdinBytes / 1024} KB per run.`;
    this.bytes += size;
    this.sent++;
    this.feeder.write(Buffer.from(text, "utf8").toString("base64") + "\n");
    this.events.onEcho(text);
    // The program is no longer waiting until the monitor sees it block again after this chunk.
    this.reportWaiting(false);
    return null;
  }

  /** Closes the program's stdin (end-of-file). */
  eof() {
    if (this.closed) return;
    this.closed = true;
    this.feeder.write("EOF\n");
    this.setWaitingAfterClose();
  }

  private setWaitingAfterClose() {
    if (this.waiting) {
      this.waiting = false;
      this.events.onWaiting(false);
    }
  }
}

/**
 * Reads client messages (debug commands, typed input) for one execution from
 * its Redis stream until `stop()` is called. Needs a dedicated connection
 * because it blocks.
 */
export function readCommands(redis: Redis, executionId: string, onPayload: (payload: Record<string, unknown>) => void): { stop: () => void } {
  let reading = true;
  void (async () => {
    let lastId = "0-0";
    const key = redisKeys.commands(executionId);
    while (reading) {
      const res = (await redis.xread("BLOCK", 1000, "STREAMS", key, lastId).catch(() => null)) as [string, [string, string[]][]][] | null;
      if (!res || !reading) continue;
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          lastId = id;
          const idx = fields.indexOf(STREAM_FIELD);
          if (idx === -1) continue;
          try {
            const payload = JSON.parse(fields[idx + 1]!) as unknown;
            if (payload && typeof payload === "object") onPayload(payload as Record<string, unknown>);
          } catch {
            // Malformed entries are ignored; the API validates what it writes.
          }
        }
      }
    }
  })();
  return {
    stop: () => {
      reading = false;
    },
  };
}

/** Applies a typed-input payload to a channel. Returns true when the payload was input (not a debug command). */
export function applyInput(payload: Record<string, unknown>, channel: InputChannel | null): boolean {
  if (!("stdin" in payload) && !("eof" in payload)) return false;
  if (!channel) return true;
  if (typeof payload.stdin === "string" && payload.stdin.length > 0 && utf8ByteLength(payload.stdin) <= REQUEST_BOUNDS.maxInputChunkBytes) {
    channel.send(payload.stdin);
  }
  if (payload.eof === true) channel.eof();
  return true;
}
