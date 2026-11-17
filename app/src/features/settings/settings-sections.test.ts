import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../engine/generated/AppSettings";
import {
  installPlatformEnvironment,
  type PlatformTarget,
} from "../../platform/environment";
import type { PushSettings, PushSwitchStatus } from "./push-settings";
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

function push(status: PushSwitchStatus | undefined): PushSettings {
  return {
    status,
    blockedIn: "browser",
    onToggle: () => {},
    onRetry: () => {},
    onOpenSystemSettings: undefined,
  };
}

function shownIn(
  target: PlatformTarget,
  pushRow: PushSettings | undefined,
  standalone = false,
): string[] {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  installPlatformEnvironment(document.body, window, { target });
  return shownSettingsSections(pushRow).map(({ id }) => id);
}

describe("settings sections", () => {
  it("offers Notifications in a browser tab for its tab row", () => {
    expect(shownIn("web", undefined)).toEqual(["appearance", "notifications"]);
    expect(shownIn("web", undefined, true)).toEqual(["appearance"]);
    expect(shownIn("tauri-desktop", undefined)).toEqual(["appearance"]);
    expect(shownIn("tauri-mobile", undefined)).toEqual(["appearance"]);
  });

  it("offers Notifications wherever push works, installed or not", () => {
    const row = push("off");
    expect(shownIn("web", row, true)).toEqual(["appearance", "notifications"]);
    expect(shownIn("tauri-desktop", row)).toEqual([
      "appearance",
      "notifications",
    ]);
    expect(shownIn("tauri-mobile", row)).toEqual([
      "appearance",
      "notifications",
    ]);
  });

  it("finds a section only where it is shown", () => {
    shownIn("web", undefined);
    expect(shownSettingsSection("notifications")?.id).toBe("notifications");
    shownIn("tauri-desktop", undefined);
    expect(shownSettingsSection("notifications")).toBeUndefined();
    expect(shownSettingsSection("notifications", push("on"))?.id).toBe(
      "notifications",
    );
    expect(shownSettingsSection("appearance")?.id).toBe("appearance");
  });

  it("summarises the tab row where there is no push row", () => {
    shownIn("web", undefined);
    const notifications = shownSettingsSection("notifications");
    expect(shownSettingsSection("appearance")?.summary(settings)).toBe(
      "Lounge · Comfortable",
    );
    expect(notifications?.summary(settings)).toBe("Unread in the tab");
    expect(
      notifications?.summary({ ...settings, unread_tab_indicator: false }),
    ).toBe("Unread hidden from the tab");
  });

  it.each([
    ["on", "Push on"],
    ["off", "Push off"],
    ["blocked", "Push blocked"],
    ["failed", "Couldn't turn on"],
  ] as const)("summarises push %s first", (status, summary) => {
    shownIn("web", undefined);
    expect(
      shownSettingsSection("notifications")?.summary(settings, push(status)),
    ).toBe(summary);
  });

  it("falls back to the tab value while push is still loading", () => {
    shownIn("web", undefined);
    expect(
      shownSettingsSection("notifications")?.summary(settings, push(undefined)),
    ).toBe("Unread in the tab");
  });
});
