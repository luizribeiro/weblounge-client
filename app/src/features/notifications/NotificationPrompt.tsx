import styles from "./NotificationPrompt.module.css";

export interface NotificationPromptControls {
  readonly notificationPromptVisible?: boolean | undefined;
  readonly onDismissNotificationPrompt?: (() => void) | undefined;
  readonly onTurnOnNotifications?: (() => void) | undefined;
}

interface NotificationPromptProps {
  readonly onDismiss: () => void;
  readonly onTurnOn: () => void;
}

export function NotificationPrompt(props: NotificationPromptProps) {
  return (
    <section
      aria-label="Notifications"
      class={styles.prompt}
      data-notification-prompt="true"
    >
      <span>Get notified about DMs and mentions</span>
      <button class={styles.turnOn} onClick={props.onTurnOn} type="button">
        Turn on
      </button>
      <button
        aria-label="Dismiss notification prompt"
        class={styles.dismiss}
        onClick={props.onDismiss}
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>
    </section>
  );
}
