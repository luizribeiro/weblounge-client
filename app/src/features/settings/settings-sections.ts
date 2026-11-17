import type { Component } from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import { type MessageKey, t } from "../../strings";
import { AppearanceIcon } from "./AppearanceIcon";
import { AppearanceSettings, densityLabel } from "./AppearanceSettings";
import { inBrowserTab } from "./in-browser-tab";
import { NotificationsIcon } from "./NotificationsIcon";
import { NotificationsSettings } from "./NotificationsSettings";
import type { PushSettings, PushSwitchStatus } from "./push-settings";
import type { SettingsPageProps } from "./settings-page-props";
import { themeName } from "./ThemeCards";

const settingsSectionIds = ["appearance", "notifications"] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

export interface SettingsSectionDefinition {
  readonly id: SettingsSectionId;
  readonly label: MessageKey;
  readonly Icon: Component;
  readonly Page: Component<SettingsPageProps>;
  readonly summary: (
    settings: AppSettings,
    push?: PushSettings | undefined,
  ) => string;
  readonly shown: (push: PushSettings | undefined) => boolean;
}

const always = () => true;

const pushSummaries: Readonly<Record<PushSwitchStatus, MessageKey>> = {
  on: "settings.notifications.summary.push_on",
  off: "settings.notifications.summary.push_off",
  blocked: "settings.notifications.summary.push_blocked",
  failed: "settings.notifications.summary.push_failed",
};

function notificationsSummary(
  settings: AppSettings,
  push?: PushSettings | undefined,
): string {
  if (push?.status !== undefined) return t(pushSummaries[push.status]);
  return settings.unread_tab_indicator
    ? t("settings.notifications.summary.tab_on")
    : t("settings.notifications.summary.tab_off");
}

const sections: Readonly<Record<SettingsSectionId, SettingsSectionDefinition>> =
  {
    appearance: {
      id: "appearance",
      label: "settings.appearance",
      Icon: AppearanceIcon,
      Page: AppearanceSettings,
      summary: (settings) =>
        t("settings.appearance.summary", {
          theme: themeName(settings.theme),
          density: densityLabel(settings.message_density),
        }),
      shown: always,
    },
    notifications: {
      id: "notifications",
      label: "settings.notifications",
      Icon: NotificationsIcon,
      Page: NotificationsSettings,
      summary: notificationsSummary,
      shown: (push) => push !== undefined || inBrowserTab(),
    },
  };

export function shownSettingsSections(
  push?: PushSettings | undefined,
): readonly SettingsSectionDefinition[] {
  return settingsSectionIds
    .map((id) => sections[id])
    .filter((section) => section.shown(push));
}

export function shownSettingsSection(
  id: SettingsSectionId,
  push?: PushSettings | undefined,
): SettingsSectionDefinition | undefined {
  const section = sections[id];
  return section.shown(push) ? section : undefined;
}
