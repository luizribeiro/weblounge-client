import { onMount } from "solid-js";
import { t } from "../strings";
import styles from "./ConfirmationDialog.module.css";

interface ConfirmationDialogProps {
  readonly action: string;
  readonly label: string;
  readonly message: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function ConfirmationDialog(props: ConfirmationDialogProps) {
  let cancel: HTMLButtonElement | undefined;
  let confirm: HTMLButtonElement | undefined;
  onMount(() => cancel?.focus({ preventScroll: true }));
  return (
    <div class={styles.backdrop}>
      <div
        aria-label={props.label}
        aria-modal="true"
        class={styles.dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
          } else if (event.key === "Tab") {
            event.preventDefault();
            (event.target === cancel ? confirm : cancel)?.focus();
          }
        }}
        role="alertdialog"
      >
        <h2>{props.message}</h2>
        <p>{t("sidebar.leave_explanation")}</p>
        <div class={styles.actions}>
          <button onClick={props.onCancel} ref={cancel} type="button">
            {t("common.cancel")}
          </button>
          <button
            class={styles.confirm}
            onClick={props.onConfirm}
            ref={confirm}
            type="button"
          >
            {props.action}
          </button>
        </div>
      </div>
    </div>
  );
}
