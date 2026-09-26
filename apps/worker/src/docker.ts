import Docker from "dockerode";
import { LANGUAGES } from "@cw/shared";
import type { Logger } from "./logger.js";
import { SANDBOX_LABEL } from "./sandbox/sandbox.js";

export function createDocker(host?: string): Docker {
  if (!host) return new Docker();
  if (host.startsWith("npipe://")) return new Docker({ socketPath: host.replace("npipe://", "") });
  if (host.startsWith("unix://")) return new Docker({ socketPath: host.replace("unix://", "") });
  const url = new URL(host.replace(/^tcp:/, "http:"));
  return new Docker({ host: url.hostname, port: Number(url.port || 2375), protocol: "http" });
}

export async function dockerAvailable(docker: Docker): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function hasImage(docker: Docker, image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

async function pull(docker: Docker, image: string): Promise<void> {
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

/** Returns ids of languages whose sandbox image is present locally. */
export async function readyLanguages(docker: Docker): Promise<string[]> {
  const out: string[] = [];
  for (const lang of LANGUAGES) if (await hasImage(docker, lang.runtime.image)) out.push(lang.id);
  return out;
}

/** Pulls any missing sandbox images, one at a time, reporting progress. */
export async function ensureImages(docker: Docker, log: Logger, onProgress: () => void): Promise<void> {
  const images = [...new Set(LANGUAGES.map((l) => l.runtime.image))];
  for (const image of images) {
    if (await hasImage(docker, image)) continue;
    log.info("pulling sandbox image", { image });
    const started = Date.now();
    try {
      await pull(docker, image);
      log.info("pulled sandbox image", { image, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      log.error("failed to pull sandbox image", { image, error: e instanceof Error ? e.message : String(e) });
    }
    onProgress();
  }
}

/** Removes sandbox containers left behind by a crashed worker. */
export async function sweepOrphans(docker: Docker, log: Logger): Promise<void> {
  const containers = await docker.listContainers({ all: true, filters: { label: [`${SANDBOX_LABEL}=1`] } });
  for (const c of containers) {
    try {
      await docker.getContainer(c.Id).remove({ force: true, v: true });
    } catch {}
  }
  if (containers.length) log.warn("removed orphaned sandbox containers", { count: containers.length });
}
