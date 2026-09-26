import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
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
export function clientHash(ip: string | undefined): string {
  return createHash("sha256")
    .update(`${config.clientHashSalt}:${ip ?? "unknown"}`)
    .digest("hex");
}

/**
 * Client IP of a raw upgrade request, derived the way Express derives req.ip:
 * the left-most X-Forwarded-For entry when TRUST_PROXY=1, else the socket peer.
 */
export function clientIp(req: IncomingMessage): string | undefined {
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress;
}
