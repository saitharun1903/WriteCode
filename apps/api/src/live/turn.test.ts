import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TURN_TTL_SECONDS, iceServers, turnCredential } from "./turn.js";

describe("relay credentials", () => {
  it("are the expiry and a label, signed the way coturn checks them", () => {
    const { username, credential } = turnCredential("s3cret", "room1234", 1_000_000_000);
    expect(username).toBe(`${1_000_000 + TURN_TTL_SECONDS}:room1234`);
    expect(credential).toBe(createHmac("sha1", "s3cret").update(username).digest("base64"));
    expect(turnCredential("other", "room1234", 1_000_000_000).credential).not.toBe(credential);
  });

  it("are offered only when a relay is configured; the secret is never sent", () => {
    expect(iceServers({ secret: "", urls: [] }, "r")).toHaveLength(1);
    expect(iceServers({ secret: "s3cret", urls: [] }, "r")).toHaveLength(1);
    const servers = iceServers({ secret: "s3cret", urls: ["turn:example.org:3478?transport=udp"] }, "r");
    expect(servers[1]).toMatchObject({ urls: ["turn:example.org:3478?transport=udp"] });
    expect(JSON.stringify(servers)).not.toContain("s3cret");
  });
});
