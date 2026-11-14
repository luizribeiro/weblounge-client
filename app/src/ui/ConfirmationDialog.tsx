import { createSignal, onMount } from "solid-js";
import { t } from "../strings";
import styles from "./ConfirmationDialog.module.css";

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
  const focusables = () =>
    [cancel, checkbox, confirm].filter(
      (element): element is HTMLButtonElement | HTMLInputElement =>
        element !== undefined,
    );
  const cycleFocus = (from: EventTarget | null, backwards: boolean) => {
    const elements = focusables();
    const index =
      from === null ? -1 : (elements as readonly EventTarget[]).indexOf(from);
    const step = backwards ? elements.length - 1 : 1;
    const next =
      index < 0 ? (backwards ? elements.length - 1 : 0) : index + step;
    elements[next % elements.length]?.focus();
  };
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
            cycleFocus(event.target, event.shiftKey);
          }
        }}
        role="alertdialog"
      >
        <h2>{props.message}</h2>
        <p>{props.explanation}</p>
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
      </div>
    </div>
  );
}
