import { Show } from "solid-js";
import { t } from "../../strings";
import { inBrowserTab } from "./in-browser-tab";
import { NotificationSwitchRow } from "./NotificationSwitchRow";
import { SettingRow } from "./SettingRow";
import { SettingSwitch } from "./SettingSwitch";
import styles from "./SettingsHeading.module.css";
import type { SettingsPageProps } from "./settings-page-props";

export function NotificationsSettings(props: SettingsPageProps) {
  return (
    <>
      <Show when={props.notifications}>
        {(notifications) => (
          <NotificationSwitchRow notifications={notifications()} />
        )}
      </Show>
      <Show when={inBrowserTab()}>
        <h3 class={styles.section}>{t("settings.browser_tab")}</h3>
        <SettingRow
          control="switch"
          description={t("settings.unread_tab_indicator.description")}
          label={t("settings.unread_tab_indicator")}
        >
          {(ids) => (
            <SettingSwitch
              {...ids}
              checked={props.settings?.unread_tab_indicator}
              onChange={(value) =>
                props.onChange({
                  scope: "app",
                  setting: { key: "unread_tab_indicator", value },
                })
              }
            />
          )}
        </SettingRow>
      </Show>
    </>
  );
}
