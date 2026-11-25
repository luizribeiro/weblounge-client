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
        if (event.key !== "Escape") return;
        event.stopPropagation();
        props.onCancel();
      }}
      role="alertdialog"
    >
      <span>{props.message}</span>
      {/* Mousedown, not pointerdown: WebKit drops a touch tap's click when its pointerdown is prevented. */}
      <button
        class={styles.confirm}
        onClick={() => props.onConfirm()}
        onMouseDown={(event) => event.preventDefault()}
        ref={(button) => props.confirmRef?.(button)}
        type="button"
      >
        {props.action}
      </button>
      <button
        class={styles.cancel}
        onClick={() => props.onCancel()}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        {t("common.cancel")}
      </button>
    </div>
  );
}
