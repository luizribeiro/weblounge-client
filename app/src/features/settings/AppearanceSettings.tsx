import { createUniqueId, Show } from "solid-js";
import { densities } from "../../engine/decodeSettings";
import type { AppSetting } from "../../engine/generated/AppSetting";
import type { Density } from "../../engine/generated/Density";
import { platformEnvironment } from "../../platform/environment";
import { t } from "../../strings";
import { NotificationsSettings } from "./NotificationsSettings";
import { SegmentedChoice } from "./SegmentedChoice";
import { SettingRow } from "./SettingRow";
import styles from "./SettingsHeading.module.css";
import type { SettingsPageProps } from "./settings-page-props";
import { ThemeCards } from "./ThemeCards";

export function AppearanceSettings(props: SettingsPageProps) {
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
        <NotificationsSettings
          onChange={props.onChange}
          settings={props.settings}
        />
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
