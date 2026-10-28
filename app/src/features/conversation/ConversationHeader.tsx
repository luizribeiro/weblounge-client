import type { JSX } from "solid-js";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import styles from "./ConversationHeader.module.css";

interface ConversationHeaderProps {
  readonly title: string;
  readonly topic?: string;
  readonly sidebarTooltip: string;
  readonly membersTooltip: string;
  readonly onToggleSidebar: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onToggleMembers: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}

export function ConversationHeader(props: ConversationHeaderProps) {
  return (
    <header class={styles.header} data-main-header="true">
      <button
        aria-label="Toggle channel list"
        class={styles.iconButton}
        onClick={props.onToggleSidebar}
        title={props.sidebarTooltip}
        type="button"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <div class={styles.identity}>
        <h2 class={styles.title}>
          <Line>{props.title}</Line>
        </h2>
        {props.topic !== undefined && props.topic !== "" && (
          <Line class={styles.topic}>
            <Selectable surfaceId="conversation-topic">
              {props.topic}
            </Selectable>
          </Line>
        )}
      </div>
      <button
        aria-label="Toggle member list"
        class={styles.iconButton}
        onClick={props.onToggleMembers}
        title={props.membersTooltip}
        type="button"
      >
        <span aria-hidden="true">♟</span>
      </button>
    </header>
  );
}
