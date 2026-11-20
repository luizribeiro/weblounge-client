import { Show } from "solid-js";
import type { PeerPresence } from "../engine/protocol";
import { BotIcon } from "./BotIcon";
import styles from "./PresenceMark.module.css";

interface PresenceMarkProps {
  readonly presence: PeerPresence | undefined;
  readonly bot: boolean;
  readonly class?: string | undefined;
}

export function PresenceMark(props: PresenceMarkProps) {
  const classes = (own: string | undefined) => `${own} ${props.class ?? ""}`;
  return (
    <Show
      fallback={
        <Show when={props.presence}>
          {(presence) => (
            <span
              aria-hidden="true"
              class={classes(styles.dot)}
              data-presence={presence()}
              data-presence-dot="true"
            />
          )}
        </Show>
      }
      when={props.bot}
    >
      <BotIcon
        class={classes(styles.bot)}
        data-peer-bot="true"
        data-presence={props.presence}
      />
    </Show>
  );
}
