import type { Component } from "solid-js";
import { buildVersion } from "../../build-version";
import type { AppSettings } from "../../engine/generated/AppSettings";
import { type MessageKey, t } from "../../strings";
import { AboutIcon } from "./AboutIcon";
import { AboutSettings } from "./AboutSettings";
import { AccountIcon } from "./AccountIcon";
import { AccountSettings, membersSiteName } from "./AccountSettings";
import { AppearanceIcon } from "./AppearanceIcon";
import { AppearanceSettings, densityLabel } from "./AppearanceSettings";
import { inBrowserTab } from "./in-browser-tab";
import { NotificationsIcon } from "./NotificationsIcon";
import { NotificationsSettings } from "./NotificationsSettings";
import type {
  NotificationSwitch,
  PageSwitchStatus,
  PushSwitchStatus,
} from "./push-settings";
import type { SettingsHost, SettingsPageProps } from "./settings-page-props";
import { themeName } from "./ThemeCards";

const settingsSectionIds = [
  "appearance",
  "notifications",
  "account",
  "about",
] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

export interface SettingsSectionDefinition {
  readonly id: SettingsSectionId;
  readonly label: MessageKey;
  readonly Icon: Component;
  readonly Page: Component<SettingsPageProps>;
  readonly summary: (settings: AppSettings, host: SettingsHost) => string;
  readonly shown: (host: SettingsHost) => boolean;
}

const always = () => true;

const pushSummaries: Readonly<Record<PushSwitchStatus, MessageKey>> = {
  on: "settings.notifications.summary.push_on",
  off: "settings.notifications.summary.push_off",
  blocked: "settings.notifications.summary.push_blocked",
  failed: "settings.notifications.summary.push_failed",
};

const pageSummaries: Readonly<Record<PageSwitchStatus, MessageKey>> = {
  on: "settings.notifications.summary.page_on",
  off: "settings.notifications.summary.page_off",
  blocked: "settings.notifications.summary.page_blocked",
};

function switchSummary(
  notifications: NotificationSwitch | undefined,
): MessageKey | undefined {
  if (notifications === undefined) return undefined;
  switch (notifications.kind) {
    case "push":
      return summaryFor(notifications.push.status, pushSummaries);
    case "page":
      return summaryFor(notifications.page.status, pageSummaries);
  }
}

function summaryFor<S extends string>(
  status: S | undefined,
  summaries: Readonly<Record<S, MessageKey>>,
): MessageKey | undefined {
  return status === undefined ? undefined : summaries[status];
}

function notificationsSummary(
  settings: AppSettings,
  { notifications }: SettingsHost,
): string {
  const summary = switchSummary(notifications);
  if (summary !== undefined) return t(summary);
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
      shown: ({ notifications }) =>
        notifications !== undefined || inBrowserTab(),
    },
    account: {
      id: "account",
      label: "settings.account",
      Icon: AccountIcon,
      Page: AccountSettings,
      summary: (_settings, { account }) =>
        account === undefined ? "" : membersSiteName(account),
      shown: ({ account }) => account !== undefined,
    },
    about: {
      id: "about",
      label: "settings.about",
      Icon: AboutIcon,
      Page: AboutSettings,
      summary: () => buildVersion.version,
      shown: always,
    },
  };

export function shownSettingsSections(
  host: SettingsHost = {},
): readonly SettingsSectionDefinition[] {
  return settingsSectionIds
    .map((id) => sections[id])
    .filter((section) => section.shown(host));
}

export function shownSettingsSection(
  id: SettingsSectionId,
  host: SettingsHost = {},
): SettingsSectionDefinition | undefined {
  const section = sections[id];
  return section.shown(host) ? section : undefined;
}
