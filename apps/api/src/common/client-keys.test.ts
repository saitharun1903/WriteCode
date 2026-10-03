import { describe, expect, it } from "vitest";
import { clientKeys } from "./request-context.js";

describe("clientKeys", () => {
  it("gives each browser on one network its own key, and the network one of its own", () => {
    const a = clientKeys("203.0.113.7", "abcdefghijklmnop1234");
    const b = clientKeys("203.0.113.7", "zyxwvutsrqponmlk9876");
    expect(a.ip).toBe(b.ip);
    expect(a.browser).not.toBe(b.browser);
    expect(a.browser).not.toBe(a.ip);
  });

  it("without a valid browser id, the network address is the key for both", () => {
    for (const id of [undefined, "", "short", "has spaces in it!!", ["array"], "x".repeat(65)]) {
      const k = clientKeys("203.0.113.7", id);
      expect(k.browser).toBe(k.ip);
    }
  });

  it("the same browser id on another network is another client", () => {
    expect(clientKeys("203.0.113.7", "abcdefghijklmnop1234").browser).not.toBe(clientKeys("198.51.100.2", "abcdefghijklmnop1234").browser);
  });
});
