import { createSignal } from "solid-js";
import { t } from "../strings";
import styles from "./AlertDialog.module.css";
import { AlertDialogFrame } from "./AlertDialogFrame";

interface ConfirmationDialogProps {
  readonly action: string;
  readonly label: string;
  readonly message: string;
  readonly explanation: string;
  /** Offers a "remember" checkbox with this label; its value is passed to `onConfirm`. */
  readonly remember?: string;
  readonly onCancel: () => void;
  readonly onConfirm: (remember: boolean) => void;
}

export function ConfirmationDialog(props: ConfirmationDialogProps) {
  let cancel: HTMLButtonElement | undefined;
  let checkbox: HTMLInputElement | undefined;
  let confirm: HTMLButtonElement | undefined;
  const [remembered, setRemembered] = createSignal(false);
  return (
    <AlertDialogFrame
      explanation={props.explanation}
      focusables={() => [cancel, checkbox, confirm]}
      label={props.label}
      message={props.message}
      onDismiss={props.onCancel}
    >
      {props.remember !== undefined && (
        <label class={styles.remember}>
          <input
            checked={remembered()}
            onChange={(event) => setRemembered(event.currentTarget.checked)}
            ref={checkbox}
            type="checkbox"
          />
          {props.remember}
        </label>
      )}
      <div class={styles.actions}>
        <button onClick={props.onCancel} ref={cancel} type="button">
          {t("common.cancel")}
        </button>
        <button
          class={styles.confirm}
          onClick={() => props.onConfirm(remembered())}
          ref={confirm}
          type="button"
        >
          {props.action}
        </button>
      </div>
    </AlertDialogFrame>
  );
}
