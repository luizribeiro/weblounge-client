import { describe, expect, it } from "vitest";
import { decodeAppearance, decodeSettings } from "./decodeSettings";

const lounge = {
  theme: "lounge",
  message_density: "cozy",
  unread_tab_indicator: true,
  push_on_this_device: true,
};

describe("decodeSettings", () => {
  it("accepts every theme preference, density and switch the engine sends", () => {
    for (const theme of ["system", "lounge", "lounge-night"]) {
      for (const density of ["compact", "cozy", "comfortable"]) {
        for (const tab of [true, false]) {
          for (const push of [true, false]) {
            const settings = {
              app: {
                theme,
                message_density: density,
                unread_tab_indicator: tab,
                push_on_this_device: push,
              },
            };
            expect(decodeSettings(settings)).toEqual(settings);
          }
        }
      }
    }
  });

  it("rejects unknown or missing values", () => {
    expect(
      decodeSettings({ app: { ...lounge, theme: "solarized" } }),
    ).toBeUndefined();
    expect(
      decodeSettings({ app: { ...lounge, message_density: "roomy" } }),
    ).toBeUndefined();
    expect(
      decodeSettings({ app: { ...lounge, unread_tab_indicator: "yes" } }),
    ).toBeUndefined();
    expect(
      decodeSettings({ app: { ...lounge, push_on_this_device: "yes" } }),
    ).toBeUndefined();
    expect(
      decodeSettings({ app: { theme: "lounge", message_density: "cozy" } }),
    ).toBeUndefined();
    expect(decodeSettings({})).toBeUndefined();
    expect(decodeSettings(null)).toBeUndefined();
  });

  it("drops fields this build does not know", () => {
    expect(
      decodeSettings({ app: { ...lounge, avatars: false }, networks: {} }),
    ).toEqual({ app: lounge });
  });
});

describe("decodeAppearance", () => {
  it("keeps only the theme and density", () => {
    expect(decodeAppearance(lounge)).toEqual({
      theme: "lounge",
      message_density: "cozy",
    });
  });

  it("rejects a value that is not a record", () => {
    expect(decodeAppearance("lounge")).toBeUndefined();
  });
});
