import { For } from "solid-js";
import type { Redaction } from "../../engine/generated/Redaction";
import { t } from "../../strings";
import styles from "./RedactedText.module.css";
import { redactionBars } from "./redaction-bars";

export function redactedLabel(redaction: Redaction): string {
  return redaction.by === null
    ? t("messages.deleted")
    : t("messages.deleted_by", { nick: redaction.by });
}

/** A deleted message's body: black bars seeded by its msgid, one line high. */
export function RedactedText(props: {
  readonly msgid: string;
  readonly redaction: Redaction;
}) {
  return (
    <span class={styles.redacted} data-redacted="true">
      <span class={styles.label}>{redactedLabel(props.redaction)}</span>
      <span aria-hidden="true" class={styles.bars} data-redaction-bars="true">
        <For each={redactionBars(props.msgid)}>
          {(width) => (
            <span
              class={styles.bar}
              data-redaction-bar="true"
              style={{ width: `${width}ch` }}
            />
          )}
        </For>
      </span>
    </span>
  );
}
