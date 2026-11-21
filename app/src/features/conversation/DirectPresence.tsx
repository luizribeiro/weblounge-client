import { type JSX, Show } from "solid-js";
import type { PeerPresence } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import { PresenceMark } from "../../ui/PresenceMark";
import styles from "./DirectPresence.module.css";
import { presenceStatus } from "./presence-status";

interface DirectPresenceProps {
  readonly presence: PeerPresence | undefined;
  readonly sinceMs?: number | undefined;
  readonly bot: boolean;
  readonly class?: string | undefined;
  readonly fallback?: JSX.Element;
}

export function DirectPresence(props: DirectPresenceProps) {
  return (
    <Show fallback={props.fallback} when={props.presence}>
      {(presence) => (
        <span
          class={`${styles.presence} ${props.class ?? ""}`}
          data-direct-presence={presence()}
        >
          <PresenceMark bot={props.bot} presence={presence()} />
          <Line class={styles.text}>
            {presenceStatus(presence(), props.sinceMs)}
          </Line>
        </span>
      )}
    </Show>
  );
}
