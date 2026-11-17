import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../engine/generated/AppSettings";
import {
  installPlatformEnvironment,
  type PlatformTarget,
} from "../../platform/environment";
import {
  shownSettingsSection,
  shownSettingsSections,
} from "./settings-sections";

const settings: AppSettings = {
  theme: "lounge",
  message_density: "comfortable",
  unread_tab_indicator: true,
  push_on_this_device: true,
};

function shownIn(target: PlatformTarget, standalone = false): string[] {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  installPlatformEnvironment(document.body, window, { target });
  return shownSettingsSections().map(({ id }) => id);
}

describe("settings sections", () => {
  it("offers Notifications only in a browser tab, where its switch has an effect", () => {
    expect(shownIn("web")).toEqual(["appearance", "notifications"]);
    expect(shownIn("web", true)).toEqual(["appearance"]);
    expect(shownIn("tauri-desktop")).toEqual(["appearance"]);
    expect(shownIn("tauri-mobile")).toEqual(["appearance"]);
  });

  it("finds a section only where it is shown", () => {
    expect(shownSettingsSection("notifications")?.id).toBe("notifications");
    shownIn("tauri-desktop");
    expect(shownSettingsSection("notifications")).toBeUndefined();
    expect(shownSettingsSection("appearance")?.id).toBe("appearance");
  });

  it("summarises each section's current values", () => {
    expect(shownSettingsSection("appearance")?.summary(settings)).toBe(
      "Lounge · Comfortable",
    );
    expect(shownSettingsSection("notifications")?.summary(settings)).toBe(
      "Unread in the tab",
    );
    expect(
      shownSettingsSection("notifications")?.summary({
        ...settings,
        unread_tab_indicator: false,
      }),
    ).toBe("Unread hidden from the tab");
  });
});
