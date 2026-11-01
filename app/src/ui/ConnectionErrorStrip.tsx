import type { ActionableConnectionError } from "../engine/connection-state";
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
        {props.error.action === "sign_in" ? "Sign in again" : "Retry"}
      </button>
    </div>
  );
}
