import { t } from "../../strings";
import styles from "../conversation/SimpleComposer.module.css";

interface InlineConfirmationProps {
  readonly label: string;
  readonly message: string;
  readonly action: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly confirmRef?: (button: HTMLButtonElement) => void;
}

/** A confirmation above the composer whose buttons never take focus from it (design 15). */
export function InlineConfirmation(props: InlineConfirmationProps) {
  return (
    <div
      aria-label={props.label}
      class={styles.confirmation}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onCancel();
      }}
      role="alertdialog"
    >
      <span>{props.message}</span>
      <button
        class={styles.confirm}
        onClick={() => props.onConfirm()}
        onPointerDown={(event) => event.preventDefault()}
        ref={(button) => props.confirmRef?.(button)}
        type="button"
      >
        {props.action}
      </button>
      <button
        class={styles.cancel}
        onClick={() => props.onCancel()}
        onPointerDown={(event) => event.preventDefault()}
        type="button"
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
