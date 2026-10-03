import { createHash, randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Assigns every request an ID (honouring a well-formed incoming one) and logs it as JSON on completion. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  const id = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader("x-request-id", id);
  const started = performance.now();
  res.on("finish", () => {
    const line = {
      time: new Date().toISOString(),
      level: res.statusCode >= 500 ? "error" : "info",
      msg: "request",
      service: "api",
      requestId: id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(performance.now() - started),
    };
    process.stdout.write(JSON.stringify(line) + "\n");
  });
  next();
}

/** Stable, non-reversible client identifier used for rate limiting. Raw IPs are never stored. */
/**
 * The rate-limit keys of a request: its browser (the anonymous id the web app sends in
 * X-Client-Id, with the address) and its network address. Without an id, both are the address.
 */
export function clientKeys(ip: string | undefined, browserId: unknown): { browser: string; ip: string } {
  const byIp = clientHash(ip);
  const id = typeof browserId === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(browserId) ? browserId : null;
  return { browser: id ? clientHash(`${ip ?? "unknown"}|${id}`) : byIp, ip: byIp };
}

export function clientHash(ip: string | undefined): string {
  return createHash("sha256")
    .update(`${config.clientHashSalt}:${ip ?? "unknown"}`)
    .digest("hex");
}
