import { t } from "../strings";
import styles from "./AlertDialog.module.css";
import { AlertDialogFrame } from "./AlertDialogFrame";

interface ErrorDialogProps {
  readonly message: string;
  readonly explanation: string;
  readonly onDismiss: () => void;
}

/** Tells the user why something they did could not be done; OK and Escape both dismiss it. */
export function ErrorDialog(props: ErrorDialogProps) {
  let ok: HTMLButtonElement | undefined;
  return (
    <AlertDialogFrame
      explanation={props.explanation}
      focusables={() => [ok]}
      label={props.message}
      message={props.message}
      onDismiss={props.onDismiss}
    >
      <div class={styles.actions}>
        <button
          class={styles.primary}
          onClick={props.onDismiss}
          ref={ok}
          type="button"
        >
          {t("common.ok")}
        </button>
      </div>
    </AlertDialogFrame>
  );
}
