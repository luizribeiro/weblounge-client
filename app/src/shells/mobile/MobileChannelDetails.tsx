import { t } from "../../strings";
import styles from "./MobileChannelDetails.module.css";
import { MobileSheet } from "./MobileSheet";

interface MobileChannelDetailsProps {
  readonly title: string;
  readonly onDismiss: () => void;
  readonly onLeave: () => void;
  readonly onMembers: () => void;
}

export function MobileChannelDetails(props: MobileChannelDetailsProps) {
  return (
    <MobileSheet
      label={t("mobile.details_for", { title: props.title })}
      onDismiss={props.onDismiss}
    >
      <span aria-hidden="true" class={styles.grabber} />
      <h2 class={styles.title}>{props.title}</h2>
      <button
        class={styles.item}
        data-initial-focus
        onClick={() => {
          props.onMembers();
          props.onDismiss();
        }}
        type="button"
      >
        <span>{t("members.label")}</span>
        <span aria-hidden="true">›</span>
      </button>
      <button
        class={styles.leave}
        onClick={() => {
          props.onLeave();
          props.onDismiss();
        }}
        type="button"
      >
        {t("cmd.part.menu")}
      </button>
    </MobileSheet>
  );
}
