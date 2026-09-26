import { describe, expect, it } from "vitest";
import { compareStreamIds } from "./stream-hub.js";

describe("compareStreamIds", () => {
  it("orders by milliseconds then sequence", () => {
    expect(compareStreamIds("0-0", "1-0")).toBeLessThan(0);
    expect(compareStreamIds("1700000000000-5", "1700000000000-10")).toBeLessThan(0);
    expect(compareStreamIds("999-0", "1000-0")).toBeLessThan(0);
    expect(compareStreamIds("1000-3", "999-9")).toBeGreaterThan(0);
    expect(compareStreamIds("5-5", "5-5")).toBe(0);
  });
});
