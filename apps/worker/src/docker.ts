import { fileURLToPath } from "node:url";
import Docker from "dockerode";
import { DOTNET_IMAGE, GDB_IMAGE, GO_DLV_IMAGE, GO_IMAGE, KOTLIN_IMAGE, LANGUAGES, PHP_XDEBUG_IMAGE, RUST_GDB_IMAGE } from "@cw/shared";
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
  // A language that runs in the browser needs no image.
  for (const lang of LANGUAGES) if (lang.preview || (await hasImage(docker, lang.runtime.image))) out.push(lang.id);
  return out;
}

/**
 * Images the worker builds itself: a pulled image plus tools (gdb for C/C++
 * debugging and visualizing), from a Dockerfile shipped in sandbox-images/.
 */
const BUILT_IMAGES: Record<string, string> = { [GDB_IMAGE]: "gcc-gdb", [RUST_GDB_IMAGE]: "rust-gdb", [GO_IMAGE]: "golang", [GO_DLV_IMAGE]: "golang-dlv", [PHP_XDEBUG_IMAGE]: "php-xdebug", [DOTNET_IMAGE]: "dotnet", [KOTLIN_IMAGE]: "kotlin" };
const IMAGES_DIR = new URL("../sandbox-images/", import.meta.url);

async function build(docker: Docker, image: string, folder: string): Promise<void> {
  const stream = await docker.buildImage({ context: fileURLToPath(new URL(`${folder}/`, IMAGES_DIR)), src: ["Dockerfile"] }, { t: image });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null, output: { error?: string }[]) => {
      const failed = err ?? output.find((o) => o.error)?.error;
      if (failed) reject(failed instanceof Error ? failed : new Error(failed));
      else resolve();
    });
  });
}

/** Pulls any missing sandbox images, one at a time, then builds the worker's own, reporting progress. */
export async function ensureImages(docker: Docker, log: Logger, onProgress: () => void): Promise<void> {
  // Pulled here: the images that are used as they come. The worker's own are built below (their base images are pulled by the build).
  const images = [...new Set(LANGUAGES.filter((l) => !l.preview).map((l) => l.runtime.image))].filter((image) => !(image in BUILT_IMAGES));
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
  for (const [image, folder] of Object.entries(BUILT_IMAGES)) {
    if (await hasImage(docker, image)) continue;
    log.info("building sandbox image", { image });
    const started = Date.now();
    try {
      await build(docker, image, folder);
      log.info("built sandbox image", { image, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (e) {
      log.error("failed to build sandbox image", { image, error: e instanceof Error ? e.message : String(e) });
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
