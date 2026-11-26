import { Show } from "solid-js";
import type { PeerPresence } from "../engine/protocol";
import { BotIcon } from "./BotIcon";
import styles from "./PresenceMark.module.css";
import primitives from "./primitives.module.css";

interface PresenceMarkProps {
  readonly presence: PeerPresence | undefined;
  readonly bot: boolean;
  readonly class?: string | undefined;
}

/** Online is filled, away a crescent, offline a hollow ring; a bot wears the same as a badge. */
export function PresenceMark(props: PresenceMarkProps) {
  const classes = (own: string | undefined) => `${own} ${props.class ?? ""}`;
  return (
    <Show
      fallback={
        <Show when={props.presence}>
          {(presence) => (
            <span
              aria-hidden="true"
              class={classes(`${styles.dot} ${primitives.textMark}`)}
              data-presence={presence()}
              data-presence-dot="true"
            />
          )}
        </Show>
      }
      when={props.bot}
    >
      <span
        class={classes(styles.bot)}
        data-peer-bot="true"
        data-presence={props.presence}
      >
        <BotIcon />
        <Show when={props.presence}>
          <span aria-hidden="true" class={styles.badge}>
            <span class={`${styles.dot} ${styles.badgeDot}`} />
          </span>
        </Show>
      </span>
    </Show>
  );
}
