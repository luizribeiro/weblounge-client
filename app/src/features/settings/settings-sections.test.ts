import { describe, expect, it } from "vitest";
import type { AppSettings } from "../../engine/generated/AppSettings";
import {
  shownSettingsSection,
  shownSettingsSections,
} from "./settings-sections";

const settings: AppSettings = {
  theme: "lounge",
  message_density: "comfortable",
  unread_tab_indicator: true,
};

describe("settings sections", () => {
  it("lists Appearance with a summary of its current values", () => {
    expect(shownSettingsSections().map(({ id }) => id)).toEqual(["appearance"]);
    expect(shownSettingsSection("appearance")?.summary(settings)).toBe(
      "Lounge · Comfortable",
    );
  });
});
