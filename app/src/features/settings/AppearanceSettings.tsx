import { createUniqueId } from "solid-js";
import { densities } from "../../engine/decodeSettings";
import type { AppSetting } from "../../engine/generated/AppSetting";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { Density } from "../../engine/generated/Density";
import type { SettingChange } from "../../engine/generated/SettingChange";
import { t } from "../../strings";
import styles from "./AppearanceSettings.module.css";
import { SegmentedChoice } from "./SegmentedChoice";
import { ThemeCards } from "./ThemeCards";

interface AppearanceSettingsProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
}

export function AppearanceSettings(props: AppearanceSettingsProps) {
  const themeId = createUniqueId();
  const densityId = createUniqueId();
  const densityDescriptionId = createUniqueId();
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
      <div class={styles.row}>
        <div class={styles.text}>
          <span class={styles.label} id={densityId}>
            {t("settings.message_density")}
          </span>
          <span class={styles.description} id={densityDescriptionId}>
            {t("settings.message_density.description")}
          </span>
        </div>
        <SegmentedChoice
          describedBy={densityDescriptionId}
          label={densityLabel}
          labelledBy={densityId}
          onChange={(value) => change({ key: "message_density", value })}
          value={props.settings?.message_density}
          values={densities}
        />
      </div>
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
