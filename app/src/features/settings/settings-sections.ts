import type { Component } from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import { platformEnvironment } from "../../platform/environment";
import { type MessageKey, t } from "../../strings";
import { AppearanceIcon } from "./AppearanceIcon";
import { AppearanceSettings, densityLabel } from "./AppearanceSettings";
import { NotificationsIcon } from "./NotificationsIcon";
import { NotificationsSettings } from "./NotificationsSettings";
import type { SettingsPageProps } from "./settings-page-props";
import { themeName } from "./ThemeCards";

const settingsSectionIds = ["appearance", "notifications"] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

export interface SettingsSectionDefinition {
  readonly id: SettingsSectionId;
  readonly label: MessageKey;
  readonly Icon: Component;
  readonly Page: Component<SettingsPageProps>;
  readonly summary: (settings: AppSettings) => string;
  readonly shown: () => boolean;
}

const always = () => true;

const inBrowserTab = () =>
  platformEnvironment().environment().display === "browser";

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
      summary: (settings) =>
        settings.unread_tab_indicator
          ? t("settings.notifications.summary.tab_on")
          : t("settings.notifications.summary.tab_off"),
      shown: inBrowserTab,
    },
  };

export function shownSettingsSections(): readonly SettingsSectionDefinition[] {
  return settingsSectionIds
    .map((id) => sections[id])
    .filter((section) => section.shown());
}

export function shownSettingsSection(
  id: SettingsSectionId,
): SettingsSectionDefinition | undefined {
  const section = sections[id];
  return section.shown() ? section : undefined;
}
