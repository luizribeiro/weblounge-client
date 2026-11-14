import { describe, expect, it } from "vitest";
import { decodeSettings } from "./decodeSettings";

describe("decodeSettings", () => {
  it("accepts every theme preference and density the engine sends", () => {
    for (const theme of ["system", "lounge", "lounge-night"]) {
      for (const density of ["compact", "cozy", "comfortable"]) {
        const settings = { app: { theme, message_density: density } };
        expect(decodeSettings(settings)).toEqual(settings);
      }
    }
  });

  it("rejects unknown or missing values", () => {
    expect(
      decodeSettings({ app: { theme: "solarized", message_density: "cozy" } }),
    ).toBeUndefined();
    expect(
      decodeSettings({ app: { theme: "lounge", message_density: "roomy" } }),
    ).toBeUndefined();
    expect(decodeSettings({ app: { theme: "lounge" } })).toBeUndefined();
    expect(decodeSettings({})).toBeUndefined();
    expect(decodeSettings(null)).toBeUndefined();
  });

  it("drops fields this build does not know", () => {
    expect(
      decodeSettings({
        app: { theme: "lounge", message_density: "cozy", avatars: false },
        networks: {},
      }),
    ).toEqual({ app: { theme: "lounge", message_density: "cozy" } });
  });
});
