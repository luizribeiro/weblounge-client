import { createUniqueId, For, Show } from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import { t } from "../../strings";
import styles from "./MobileSettings.module.css";
import type { PushSettings } from "./push-settings";
import { SettingsRootRow } from "./SettingsRootRow";
import {
  type SettingsSectionId,
  shownSettingsSection,
  shownSettingsSections,
} from "./settings-sections";

export type MobileSettingsPage = "root" | SettingsSectionId;

interface MobileSettingsProps {
  readonly page: MobileSettingsPage;
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  readonly push?: PushSettings | undefined;
  readonly onBack: () => void;
  readonly onOpenPage: (page: MobileSettingsPage) => void;
}

export function MobileSettings(props: MobileSettingsProps) {
  const titleId = createUniqueId();
  const section = () =>
    props.page === "root"
      ? undefined
      : shownSettingsSection(props.page, props.push);
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
        <h1 id={titleId}>{t(section()?.label ?? "action.settings")}</h1>
      </header>
      <div class={styles.scroll} data-settings-layout="phone">
        <Show
          fallback={
            <For each={shownSettingsSections(props.push)}>
              {(root) => (
                <SettingsRootRow
                  onOpen={() => props.onOpenPage(root.id)}
                  push={props.push}
                  section={root}
                  settings={props.settings}
                />
              )}
            </For>
          }
          keyed
          when={section()}
        >
          {(page) => (
            <page.Page
              onChange={props.onChange}
              push={props.push}
              settings={props.settings}
            />
          )}
        </Show>
      </div>
    </section>
  );
}
