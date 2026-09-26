import { describe, expect, it } from "vitest";
import { eventToShortcut } from "./keybindings";

const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("eventToShortcut", () => {
  it("maps Ctrl to Mod on Windows/Linux and Meta on macOS", () => {
    expect(eventToShortcut(ev({ code: "KeyP", ctrlKey: true, shiftKey: true }), false)).toBe("Mod+Shift+P");
    expect(eventToShortcut(ev({ code: "KeyP", metaKey: true }), true)).toBe("Mod+P");
    expect(eventToShortcut(ev({ code: "KeyP", ctrlKey: true }), true)).toBe("P");
  });
  it("handles Enter, function keys and punctuation", () => {
    expect(eventToShortcut(ev({ code: "Enter", ctrlKey: true }), false)).toBe("Mod+Enter");
    expect(eventToShortcut(ev({ code: "F5", shiftKey: true }), false)).toBe("Shift+F5");
    expect(eventToShortcut(ev({ code: "Equal", ctrlKey: true }), false)).toBe("Mod+=");
  });
  it("ignores unmapped keys", () => {
    expect(eventToShortcut(ev({ code: "ShiftLeft", shiftKey: true }), false)).toBeNull();
  });
});
