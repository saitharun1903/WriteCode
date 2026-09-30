import { describe, expect, it } from "vitest";
import { closeMessage } from "./store";

describe("why a live session could not connect", () => {
  it("names the reason instead of a generic failure", () => {
    expect(closeMessage(0)).toMatch(/internet connection/);
    expect(closeMessage(4004)).toMatch(/ended or the link is wrong/);
    expect(closeMessage(4008)).toMatch(/full/);
    expect(closeMessage(1008)).toMatch(/writecode\.in/);
    expect(closeMessage(4400, "no join")).toBe("Could not connect to the live session: no join. Try again.");
    expect(closeMessage(1006)).toBe("Could not connect to the live session. Try again.");
  });
});
