import type { PeerPresence } from "../../engine/protocol";
import { t } from "../../strings";
import { Line } from "../../ui/Line";
import { PresenceMark } from "../../ui/PresenceMark";
import styles from "./DirectPresence.module.css";

interface DirectPresenceProps {
  readonly presence: PeerPresence;
  readonly bot: boolean;
  readonly class?: string | undefined;
}

export function DirectPresence(props: DirectPresenceProps) {
  return (
    <Line
      class={`${styles.presence} ${props.class ?? ""}`}
      data-direct-presence={props.presence}
    >
      <PresenceMark
        bot={props.bot}
        class={styles.mark}
        presence={props.presence}
      />
      {t("conversation.direct_presence", {
        presence: t(`sidebar.presence.${props.presence}`),
      })}
    </Line>
  );
}
