import { describe, expect, it } from "vitest";
import { ExecutionsService } from "./executions.service.js";

/** In-memory stand-in for the few Redis calls create() and canControl() make. */
function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    async set(key: string, value: string) {
      data.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return data.get(key) ?? null;
    },
  };
}

describe("execution control tokens", () => {
  it("accepts only the token issued to the creator, and stores just its hash", async () => {
    const redis = fakeRedis();
    const id = "3b241101-e2bb-4255-8caf-4136c566a962";
    const token = "creator-token-abc";
    const { createHash } = await import("node:crypto");
    await redis.set(`exec:${id}:control`, createHash("sha256").update(token).digest("hex"));
    const service = new ExecutionsService(null as never, null as never, null as never, redis as never, null as never, null as never, null as never);

    expect(await service.canControl(id, token)).toBe(true);
    expect(await service.canControl(id, "someone-else")).toBe(false);
    expect(await service.canControl(id, undefined)).toBe(false);
    expect(await service.canControl(id, "")).toBe(false);
    expect(await service.canControl("00000000-0000-4000-8000-000000000000", token)).toBe(false);
    expect([...redis.data.values()]).not.toContain(token);
  });
});
