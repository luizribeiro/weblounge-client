import { type JSX, Show } from "solid-js";
import type { PeerPresence } from "../../engine/protocol";
import { t } from "../../strings";
import { Line } from "../../ui/Line";
import { PresenceMark } from "../../ui/PresenceMark";
import styles from "./DirectPresence.module.css";

interface DirectPresenceProps {
  readonly presence: PeerPresence | undefined;
  readonly bot: boolean;
  readonly class?: string | undefined;
  readonly fallback?: JSX.Element;
}

export function DirectPresence(props: DirectPresenceProps) {
  return (
    <Show fallback={props.fallback} when={props.presence}>
      {(presence) => (
        <Line
          class={`${styles.presence} ${props.class ?? ""}`}
          data-direct-presence={presence()}
        >
          <PresenceMark
            bot={props.bot}
            class={styles.mark}
            presence={presence()}
          />
          {t("conversation.direct_presence", {
            presence: t(`sidebar.presence.${presence()}`),
          })}
        </Line>
      )}
    </Show>
  );
}
