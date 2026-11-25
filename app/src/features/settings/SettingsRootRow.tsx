import { Show } from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import { t } from "../../strings";
import styles from "./MobileSettings.module.css";
import type { SettingsHost } from "./settings-page-props";
import type { SettingsSectionDefinition } from "./settings-sections";

interface SettingsRootRowProps {
  readonly section: SettingsSectionDefinition;
  readonly settings: AppSettings | undefined;
  readonly host: SettingsHost;
  readonly onOpen: () => void;
}

export function SettingsRootRow(props: SettingsRootRowProps) {
  return (
    <button
      class={styles.rootRow}
      data-section={props.section.id}
      onClick={() => props.onOpen()}
      type="button"
    >
      <span aria-hidden="true" class={styles.tile}>
        <props.section.Icon />
      </span>
      <span class={styles.rowText}>
        <b>{t(props.section.label)}</b>
        <Show when={props.settings} keyed>
          {(settings) => (
            <small>{props.section.summary(settings, props.host)}</small>
          )}
        </Show>
      </span>
      <svg aria-hidden="true" class={styles.chevron} viewBox="0 0 24 24">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}
