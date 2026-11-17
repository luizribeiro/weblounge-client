import { describe, expect, it } from "vitest";
import { switchesOn } from "./app-settings-fixture";
import { decodeAppearance, decodeSettings } from "./decodeSettings";

const lounge = {
  theme: "lounge",
  message_density: "cozy",
  ...switchesOn,
};

describe("decodeSettings", () => {
  it("accepts every theme preference, density and switch the engine sends", () => {
    for (const theme of ["system", "lounge", "lounge-night"]) {
      for (const density of ["compact", "cozy", "comfortable"]) {
        for (const [tab, push, page] of switchCombinations()) {
          const settings = {
            app: {
              theme,
              message_density: density,
              unread_tab_indicator: tab,
              push_on_this_device: push,
              page_notifications: page,
            },
          };
          expect(decodeSettings(settings)).toEqual(settings);
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
      decodeSettings({ app: { ...lounge, page_notifications: 1 } }),
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

function switchCombinations(): [boolean, boolean, boolean][] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => [
    (bits & 1) !== 0,
    (bits & 2) !== 0,
    (bits & 4) !== 0,
  ]);
}
