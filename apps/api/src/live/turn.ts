import { createHmac } from "node:crypto";

/** Public STUN servers: they tell a browser its own address. No credentials, no traffic through them. */
export const STUN_URLS = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"];

/** How long a relay credential works: longer than the longest interview with its extensions. */
export const TURN_TTL_SECONDS = 6 * 60 * 60;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * A relay credential in the form coturn checks (its "REST API" scheme): the
 * user name is "<expiry>:<label>" and the password is the HMAC-SHA1 of that
 * name with the shared secret. It stops working at the expiry, so a leaked
 * one is of little use, and the secret itself never leaves the server.
 */
export function turnCredential(secret: string, label: string, now = Date.now()): { username: string; credential: string } {
  const username = `${Math.floor(now / 1000) + TURN_TTL_SECONDS}:${label}`;
  return { username, credential: createHmac("sha1", secret).update(username).digest("base64") };
}

/** What a browser passes to RTCPeerConnection: STUN always, and the relay when one is configured. */
export function iceServers(turn: { secret: string; urls: string[] }, label: string, now = Date.now()): IceServer[] {
  const servers: IceServer[] = [{ urls: STUN_URLS }];
  if (turn.secret && turn.urls.length) servers.push({ urls: turn.urls, ...turnCredential(turn.secret, label, now) });
  return servers;
}
