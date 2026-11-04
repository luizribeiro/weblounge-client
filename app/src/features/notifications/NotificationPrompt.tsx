import { t } from "../../strings";
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
      aria-label={t("notifications.label")}
      class={styles.prompt}
      data-notification-prompt="true"
    >
      <span>{t("notifications.prompt")}</span>
      <button class={styles.turnOn} onClick={props.onTurnOn} type="button">
        {t("notifications.turn_on")}
      </button>
      <button
        aria-label={t("notifications.dismiss")}
        class={styles.dismiss}
        onClick={props.onDismiss}
        type="button"
      >
        <span aria-hidden="true">×</span>
      </button>
    </section>
  );
}
