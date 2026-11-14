import { describe, expect, it } from "vitest";
import { installAppearance } from "./appearance";
import { readAppearanceHint, writeAppearanceHint } from "./appearance-hint";

const storage = () => localStorage;
const root = document.documentElement;

describe("installAppearance", () => {
  it("follows the system at the default density without a remembered copy", () => {
    installAppearance(document, true, storage);

    expect(root.dataset.theme).toBe("lounge-night");
    expect(root.dataset.messageDensity).toBe("cozy");
    expect(readAppearanceHint(storage)).toBeUndefined();
  });

  it("starts from the remembered copy before the engine answers", () => {
    writeAppearanceHint(storage, {
      theme: "lounge-night",
      message_density: "comfortable",
    });

    const appearance = installAppearance(document, false, storage);
    appearance.setSystemDark(true);
    appearance.setSystemDark(false);

    expect(root.dataset.theme).toBe("lounge-night");
    expect(root.dataset.messageDensity).toBe("comfortable");
  });

  it("applies the engine's values and remembers them for the next launch", () => {
    const appearance = installAppearance(document, true, storage);

    appearance.apply({ theme: "lounge", message_density: "compact" });

    expect(root.dataset.theme).toBe("lounge");
    expect(root.dataset.messageDensity).toBe("compact");
    expect(readAppearanceHint(storage)).toEqual({
      theme: "lounge",
      message_density: "compact",
    });

    appearance.apply({ theme: "system", message_density: "cozy" });
    expect(root.dataset.theme).toBe("lounge-night");
  });
});
