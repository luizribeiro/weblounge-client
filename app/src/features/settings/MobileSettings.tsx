import { createUniqueId, Show } from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import { t } from "../../strings";
import { AppearanceIcon } from "./AppearanceIcon";
import { AppearanceSettings, densityLabel } from "./AppearanceSettings";
import styles from "./MobileSettings.module.css";
import { themeName } from "./ThemeCards";

export type MobileSettingsPage = "root" | "appearance";

interface MobileSettingsProps {
  readonly page: MobileSettingsPage;
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  readonly onBack: () => void;
  readonly onOpenPage: (page: MobileSettingsPage) => void;
}

export function MobileSettings(props: MobileSettingsProps) {
  const titleId = createUniqueId();
  return (
    <section
      aria-labelledby={titleId}
      class={styles.settings}
      data-mobile-settings={props.page}
    >
      <header class={styles.header}>
        <button
          aria-label={
            props.page === "root"
              ? t("mobile.back_to_chats")
              : t("settings.back_to_settings")
          }
          class={styles.back}
          onClick={() => props.onBack()}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 id={titleId}>
          {props.page === "root"
            ? t("action.settings")
            : t("settings.appearance")}
        </h1>
      </header>
      <div class={styles.scroll} data-settings-layout="phone">
        <Show
          fallback={
            <AppearanceSettings
              onChange={props.onChange}
              settings={props.settings}
            />
          }
          when={props.page === "root"}
        >
          <button
            class={styles.rootRow}
            onClick={() => props.onOpenPage("appearance")}
            type="button"
          >
            <span aria-hidden="true" class={styles.tile}>
              <AppearanceIcon />
            </span>
            <span class={styles.rowText}>
              <b>{t("settings.appearance")}</b>
              <Show when={props.settings} keyed>
                {(settings) => (
                  <small>
                    {t("settings.appearance.summary", {
                      theme: themeName(settings.theme),
                      density: densityLabel(settings.message_density),
                    })}
                  </small>
                )}
              </Show>
            </span>
            <svg aria-hidden="true" class={styles.chevron} viewBox="0 0 24 24">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </Show>
      </div>
    </section>
  );
}
