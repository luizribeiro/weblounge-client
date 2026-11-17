import type { UnverifiedSender } from "../../engine/protocol";
import { t } from "../../strings";
import styles from "./UnverifiedSenderExplanation.module.css";

export function UnverifiedSenderExplanation(props: {
  readonly reason: UnverifiedSender;
  readonly titleId?: string | undefined;
}) {
  return (
    <div class={styles.explanation} data-initial-focus tabIndex={-1}>
      <h2 class={styles.title} id={props.titleId}>
        {t("messages.unverified_sender")}
      </h2>
      <p class={styles.body}>
        {t(`messages.unverified_sender.${props.reason}`)}
      </p>
    </div>
  );
}
