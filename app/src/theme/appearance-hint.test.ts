import { describe, expect, it } from "vitest";
import {
  appearanceHintKey,
  applyAppearanceHint,
  readAppearanceHint,
  writeAppearanceHint,
} from "./appearance-hint";

const storage = () => localStorage;

describe("appearance hint", () => {
  it("round-trips the engine's appearance settings", () => {
    writeAppearanceHint(storage, {
      theme: "lounge-night",
      message_density: "compact",
    });

    expect(readAppearanceHint(storage)).toEqual({
      theme: "lounge-night",
      message_density: "compact",
    });
  });

  it("ignores a missing copy", () => {
    expect(readAppearanceHint(storage)).toBeUndefined();
  });

  it.each([
    ["corrupt", "{not json"],
    [
      "unversioned",
      JSON.stringify({ theme: "lounge", message_density: "cozy" }),
    ],
    [
      "newer",
      JSON.stringify({ version: 2, theme: "lounge", message_density: "cozy" }),
    ],
    [
      "unknown theme",
      JSON.stringify({ version: 1, theme: "neon", message_density: "cozy" }),
    ],
  ])("ignores a %s copy", (_case, stored) => {
    localStorage.setItem(appearanceHintKey, stored);

    expect(readAppearanceHint(storage)).toBeUndefined();
  });

  it("survives storage that throws", () => {
    const blocked = (): Storage => {
      throw new DOMException("blocked", "SecurityError");
    };

    expect(readAppearanceHint(blocked)).toBeUndefined();
    expect(() =>
      writeAppearanceHint(blocked, {
        theme: "lounge",
        message_density: "cozy",
      }),
    ).not.toThrow();
  });

  it("paints the remembered theme and density, resolving System", () => {
    const root = document.createElement("html");

    applyAppearanceHint(
      root,
      { theme: "system", message_density: "comfortable" },
      true,
    );
    expect(root.dataset.theme).toBe("lounge-night");
    expect(root.dataset.messageDensity).toBe("comfortable");

    applyAppearanceHint(
      root,
      { theme: "lounge", message_density: "compact" },
      true,
    );
    expect(root.dataset.theme).toBe("lounge");
    expect(root.dataset.messageDensity).toBe("compact");
  });

  it("leaves the page alone without a copy", () => {
    const root = document.createElement("html");

    applyAppearanceHint(root, undefined, true);

    expect(root.dataset.theme).toBeUndefined();
  });
});
