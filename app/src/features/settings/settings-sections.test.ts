import { describe, expect, it, vi } from "vitest";
import { buildVersion } from "../../build-version";
import { switchesOn } from "../../engine/app-settings-fixture";
import type { AppSettings } from "../../engine/generated/AppSettings";
import {
  installPlatformEnvironment,
  type PlatformTarget,
} from "../../platform/environment";
import type {
  NotificationSwitch,
  PageSwitchStatus,
  PushSwitchStatus,
} from "./push-settings";
import {
  shownSettingsSection,
  shownSettingsSections,
} from "./settings-sections";

const settings: AppSettings = {
  theme: "lounge",
  message_density: "comfortable",
  ...switchesOn,
};

function push(status: PushSwitchStatus | undefined): NotificationSwitch {
  return {
    kind: "push",
    push: {
      status,
      blockedIn: "browser",
      onToggle: () => {},
      onRetry: () => {},
      onOpenSystemSettings: undefined,
    },
  };
}

function page(status: PageSwitchStatus | undefined): NotificationSwitch {
  return {
    kind: "page",
    page: { status, blockedIn: "macos", onToggle: () => {} },
  };
}

function shownIn(
  target: PlatformTarget,
  notifications: NotificationSwitch | undefined,
  standalone = false,
): string[] {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  installPlatformEnvironment(document.body, window, { target });
  return shownSettingsSections({ notifications }).map(({ id }) => id);
}

describe("settings sections", () => {
  it("offers Notifications in a browser tab for its tab row", () => {
    expect(shownIn("web", undefined)).toEqual([
      "appearance",
      "notifications",
      "about",
    ]);
    expect(shownIn("web", undefined, true)).toEqual(["appearance", "about"]);
    expect(shownIn("tauri-desktop", undefined)).toEqual([
      "appearance",
      "about",
    ]);
    expect(shownIn("tauri-mobile", undefined)).toEqual(["appearance", "about"]);
  });

  it("offers Notifications wherever push works, installed or not", () => {
    const row = push("off");
    const all = ["appearance", "notifications", "about"];
    expect(shownIn("web", row, true)).toEqual(all);
    expect(shownIn("tauri-desktop", row)).toEqual(all);
    expect(shownIn("tauri-mobile", row)).toEqual(all);
  });

  it("offers Account before About where the app signed in to weblounge", () => {
    shownIn("web", undefined);
    const account = {
      membersSite: "https://members.weblounge.org",
      onSignOut: () => {},
    };

    expect(shownSettingsSections({ account }).map(({ id }) => id)).toEqual([
      "appearance",
      "notifications",
      "account",
      "about",
    ]);
    expect(shownSettingsSection("account")).toBeUndefined();
    expect(
      shownSettingsSection("account", { account })?.summary(settings, {
        account,
      }),
    ).toBe("members.weblounge.org");
  });

  it("summarises About with the build version", () => {
    shownIn("web", undefined);
    expect(shownSettingsSection("about")?.summary(settings, {})).toBe(
      buildVersion.version,
    );
  });

  it("offers Notifications in the Mac app for its page notifications row", () => {
    expect(shownIn("tauri-desktop", page("on"))).toEqual([
      "appearance",
      "notifications",
      "about",
    ]);
  });

  it.each([
    ["on", "Notifications on"],
    ["off", "Notifications off"],
    ["blocked", "Notifications blocked"],
  ] as const)("summarises page notifications %s", (status, summary) => {
    shownIn("tauri-desktop", undefined);
    expect(
      shownSettingsSection("notifications", {
        notifications: page(status),
      })?.summary(settings, { notifications: page(status) }),
    ).toBe(summary);
  });

  it("finds a section only where it is shown", () => {
    shownIn("web", undefined);
    expect(shownSettingsSection("notifications")?.id).toBe("notifications");
    shownIn("tauri-desktop", undefined);
    expect(shownSettingsSection("notifications")).toBeUndefined();
    expect(
      shownSettingsSection("notifications", { notifications: push("on") })?.id,
    ).toBe("notifications");
    expect(shownSettingsSection("appearance")?.id).toBe("appearance");
  });

  it("summarises the tab row where there is no push row", () => {
    shownIn("web", undefined);
    const notifications = shownSettingsSection("notifications");
    expect(shownSettingsSection("appearance")?.summary(settings, {})).toBe(
      "Lounge · Comfortable",
    );
    expect(notifications?.summary(settings, {})).toBe("Unread in the tab");
    expect(
      notifications?.summary({ ...settings, unread_tab_indicator: false }, {}),
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
      shownSettingsSection("notifications")?.summary(settings, {
        notifications: push(status),
      }),
    ).toBe(summary);
  });

  it("falls back to the tab value while push is still loading", () => {
    shownIn("web", undefined);
    expect(
      shownSettingsSection("notifications")?.summary(settings, {
        notifications: push(undefined),
      }),
    ).toBe("Unread in the tab");
  });
});
