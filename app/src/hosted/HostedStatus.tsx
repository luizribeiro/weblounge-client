import styles from "./HostedStatus.module.css";

interface HostedStatusProps {
  message: string;
  error?: boolean;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
}

export function HostedStatus(props: HostedStatusProps) {
  return (
    <main class={styles.root} data-hosted-status>
      <img
        class={styles.mark}
        src="/brand/chair.svg"
        alt=""
        draggable={false}
      />
      <p role={props.error === true ? "alert" : "status"}>{props.message}</p>
      {props.onRetry !== undefined && (
        <button class={styles.retry} onClick={props.onRetry} type="button">
          {props.retryLabel ?? "Retry"}
        </button>
      )}
    </main>
  );
}
