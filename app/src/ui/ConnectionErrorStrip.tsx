import type { ActionableConnectionError } from "../engine/connection-state";
import { t } from "../strings";
import styles from "./ConnectionErrorStrip.module.css";

interface ConnectionErrorStripProps {
  readonly error: ActionableConnectionError;
  readonly onAction: (networkId: number) => void;
}

export function ConnectionErrorStrip(props: ConnectionErrorStripProps) {
  return (
    <div class={styles.strip} data-connection-error="true" role="alert">
      <span>{props.error.message}</span>
      <button
        onClick={() => props.onAction(props.error.networkId)}
        type="button"
      >
        {t(
          props.error.action === "sign_in"
            ? "common.sign_in_again"
            : "common.retry",
        )}
      </button>
    </div>
  );
}
