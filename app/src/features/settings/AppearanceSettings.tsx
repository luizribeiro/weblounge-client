import { createUniqueId, Show } from "solid-js";
import { densities } from "../../engine/decodeSettings";
import type { AppSetting } from "../../engine/generated/AppSetting";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { Density } from "../../engine/generated/Density";
import type { SettingChange } from "../../engine/generated/SettingChange";
import { platformEnvironment } from "../../platform/environment";
import { t } from "../../strings";
import { SegmentedChoice } from "./SegmentedChoice";
import { SettingRow } from "./SettingRow";
import { SettingSwitch } from "./SettingSwitch";
import styles from "./SettingsHeading.module.css";
import { ThemeCards } from "./ThemeCards";

interface AppearanceSettingsProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
}

export function AppearanceSettings(props: AppearanceSettingsProps) {
  const themeId = createUniqueId();
  const inBrowserTab = () =>
    platformEnvironment().environment().display === "browser";
  const change = (setting: AppSetting) =>
    props.onChange({ scope: "app", setting });
  return (
    <>
      <h3 class={styles.section} data-before="cards" id={themeId}>
        {t("settings.theme")}
      </h3>
      <ThemeCards
        labelledBy={themeId}
        onChange={(value) => change({ key: "theme", value })}
        value={props.settings?.theme}
      />
      <h3 class={styles.section}>{t("settings.conversation")}</h3>
      <SettingRow
        control="choice"
        description={t("settings.message_density.description")}
        label={t("settings.message_density")}
      >
        {(ids) => (
          <SegmentedChoice
            {...ids}
            label={densityLabel}
            onChange={(value) => change({ key: "message_density", value })}
            value={props.settings?.message_density}
            values={densities}
          />
        )}
      </SettingRow>
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
                change({ key: "unread_tab_indicator", value })
              }
            />
          )}
        </SettingRow>
      </Show>
    </>
  );
}

export function densityLabel(density: Density): string {
  switch (density) {
    case "compact":
      return t("settings.density.compact");
    case "cozy":
      return t("settings.density.cozy");
    case "comfortable":
      return t("settings.density.comfortable");
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}
