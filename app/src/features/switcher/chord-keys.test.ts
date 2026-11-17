import { describe, expect, it } from "vitest";
import { chordKeys } from "./chord-keys";

describe("chordKeys", () => {
  it("splits macOS glyph chords into one key per modifier", () => {
    expect(chordKeys("⇧⌘.")).toEqual(["⇧", "⌘", "."]);
    expect(chordKeys("⌃⇧Tab")).toEqual(["⌃", "⇧", "Tab"]);
    expect(chordKeys("⌥↑")).toEqual(["⌥", "↑"]);
  });

  it("splits plus-joined chords on other platforms", () => {
    expect(chordKeys("Ctrl+Shift+,")).toEqual(["Ctrl", "Shift", ","]);
    expect(chordKeys("Alt+↓")).toEqual(["Alt", "↓"]);
    expect(chordKeys("Ctrl++")).toEqual(["Ctrl", "+"]);
  });

  it("keeps a single named key whole", () => {
    expect(chordKeys("End")).toEqual(["End"]);
    expect(chordKeys("+")).toEqual(["+"]);
  });
});
