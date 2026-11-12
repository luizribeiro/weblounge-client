import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../strings";
import styles from "./MobileChatActionSheet.module.css";
import { MobileChatRow } from "./MobileChatRow";
import { MobileSheet } from "./MobileSheet";

interface MobileChatActionSheetProps {
  readonly buffer: BufferProjection;
  readonly networkLabel?: string | undefined;
  readonly rowTop: number;
  readonly onDismiss: () => void;
  readonly onMarkRead: () => void;
  readonly onRequestClose: () => void;
}

export function MobileChatActionSheet(props: MobileChatActionSheetProps) {
  const run = (action: () => void) => {
    action();
    props.onDismiss();
  };
  return (
    <MobileSheet
      floating={
        <div
          aria-hidden="true"
          class={styles.lifted}
          inert
          style={{ "--wl-mobile-lifted-top": `${props.rowTop}px` }}
        >
          <MobileChatRow
            buffer={props.buffer}
            networkLabel={props.networkLabel}
            onOpen={() => {}}
            previews={true}
          />
        </div>
      }
      label={t("mobile.actions_for", { title: props.buffer.title })}
      onDismiss={props.onDismiss}
    >
      <div class={styles.group}>
        <button
          data-initial-focus
          onClick={() => run(props.onMarkRead)}
          type="button"
        >
          {t("action.mark_read")}
        </button>
        <button
          class={styles.danger}
          onClick={() => run(props.onRequestClose)}
          type="button"
        >
          {props.buffer.kind === "channel"
            ? t("mobile.leave_target", { title: props.buffer.title })
            : t("mobile.close_target", { title: props.buffer.title })}
        </button>
      </div>
      <button class={styles.cancel} onClick={props.onDismiss} type="button">
        {t("common.cancel")}
      </button>
    </MobileSheet>
  );
}
