import { t } from "../../strings";
import { CloseIcon } from "../../ui/icons/CloseIcon";
import { ReplyIcon } from "../../ui/icons/ReplyIcon";
import { nickColor } from "../conversation/nick-color";
import styles from "./ReplyBar.module.css";
import type { ReplyDraft } from "./reply-drafts";

/** The composer's "Replying to" line; keeping focus in the field lets × cancel mid-typing. */
export function ReplyBar(props: {
  readonly reply: ReplyDraft;
  readonly onCancel: () => void;
}) {
  return (
    <div class={styles.bar} data-reply-bar="true">
      <ReplyIcon class={styles.icon} />
      <span class={styles.label}>
        {t("reply.replying_to")}{" "}
        <span
          class={styles.nick}
          style={{ color: nickColor(props.reply.nickColorIndex) }}
        >
          {props.reply.author}
        </span>
      </span>{" "}
      <span class={styles.text}>{props.reply.text}</span>
      {/* Mousedown, not pointerdown: WebKit drops a touch tap's click when its pointerdown is prevented. */}
      <button
        aria-label={t("reply.cancel")}
        class={styles.cancel}
        onClick={() => props.onCancel()}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
