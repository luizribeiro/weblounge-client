import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onMount,
  Show,
} from "solid-js";
import type { AppSettings } from "../../engine/generated/AppSettings";
import type { SettingChange } from "../../engine/generated/SettingChange";
import { t } from "../../strings";
import { trapTab } from "../../ui/focus-trap";
import type { NotificationSwitch } from "./push-settings";
import styles from "./SettingsModal.module.css";
import { SettingsSectionNav } from "./SettingsSectionNav";
import {
  type SettingsSectionId,
  shownSettingsSections,
} from "./settings-sections";

interface SettingsModalProps {
  readonly settings: AppSettings | undefined;
  readonly onChange: (change: SettingChange) => void;
  readonly notifications?: NotificationSwitch | undefined;
  readonly onClose: () => void;
  readonly rail?: boolean | undefined;
}

export function SettingsModal(props: SettingsModalProps) {
  const titleId = createUniqueId();
  const labelIdFor = (id: SettingsSectionId) => `${titleId}-${id}`;
  const shown = createMemo(() => shownSettingsSections(props.notifications));
  const sections = createMemo(() =>
    shown().map((section) => ({
      id: section.id,
      label: t(section.label),
      labelId: labelIdFor(section.id),
      icon: () => <section.Icon />,
    })),
  );
  const [chosen, setChosen] = createSignal<SettingsSectionId>("appearance");
  const current = createMemo(
    () => shown().find(({ id }) => id === chosen()) ?? shown()[0],
  );
  const [railExpanded, setRailExpanded] = createSignal(false);
  createEffect(() => {
    if (props.rail !== true) setRailExpanded(false);
  });
  let dialog: HTMLDivElement | undefined;
  onMount(() => dialog?.focus({ preventScroll: true }));
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (props.rail === true && railExpanded()) setRailExpanded(false);
      else props.onClose();
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
          <SettingsSectionNav
            current={current()?.id ?? chosen()}
            expanded={railExpanded()}
            onExpandedChange={setRailExpanded}
            onSelect={setChosen}
            rail={props.rail === true}
            sections={sections()}
          />
          <Show when={current()} keyed>
            {(section) => (
              <section
                aria-labelledby={labelIdFor(section.id)}
                class={styles.pane}
              >
                <section.Page
                  onChange={props.onChange}
                  notifications={props.notifications}
                  settings={props.settings}
                />
              </section>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
