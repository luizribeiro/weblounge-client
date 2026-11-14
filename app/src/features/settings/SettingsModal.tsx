import { createUniqueId, onMount } from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import { t } from "../../strings";
import { trapTab } from "../../ui/focus-trap";
import { AppearanceIcon } from "./AppearanceIcon";
import { AppearanceSettings } from "./AppearanceSettings";
import styles from "./SettingsModal.module.css";

interface SettingsModalProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  readonly onClose: () => void;
}

export function SettingsModal(props: SettingsModalProps) {
  const titleId = createUniqueId();
  const sectionId = createUniqueId();
  let dialog: HTMLDivElement | undefined;
  onMount(() => dialog?.focus({ preventScroll: true }));
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    trapTab(event, dialog);
  };
  return (
    <div class={styles.overlay} data-settings-modal="true">
      <button
        aria-hidden="true"
        class={styles.backdrop}
        onClick={props.onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        class={styles.modal}
        data-keyboard-surface="true"
        data-settings-layout="desktop"
        onKeyDown={keydown}
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <header class={styles.head}>
          <h2 id={titleId}>{t("action.settings")}</h2>
          <button
            aria-label={t("settings.close")}
            class={styles.close}
            onClick={props.onClose}
            title={t("settings.close")}
            type="button"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div class={styles.body}>
          <nav aria-label={t("settings.sections")} class={styles.nav}>
            <button aria-current="page" class={styles.section} type="button">
              <AppearanceIcon />
              <span id={sectionId}>{t("settings.appearance")}</span>
            </button>
          </nav>
          <section aria-labelledby={sectionId} class={styles.pane}>
            <AppearanceSettings
              onChange={props.onChange}
              settings={props.settings}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
