import type { JSX } from "solid-js";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import styles from "./ConversationHeader.module.css";

interface ConversationHeaderProps {
  readonly title: string;
  readonly topic?: string | undefined;
  readonly sidebarTooltip: string;
  readonly membersTooltip: string;
  readonly memberCount?: number | undefined;
  readonly membersPressed?: boolean | undefined;
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
      {props.memberCount !== undefined && (
        <button
          aria-label="Toggle member list"
          aria-pressed={props.membersPressed ?? false}
          class={`${styles.iconButton} ${styles.memberButton}`}
          onClick={props.onToggleMembers}
          title={props.membersTooltip}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="9" cy="8" r="3" />
            <path d="M3.5 18c.5-3.2 2.3-5 5.5-5s5 1.8 5.5 5" />
            <circle cx="17" cy="9" r="2.4" />
            <path d="M15.4 14.1c2.9-.7 4.6.6 5.1 3.4" />
          </svg>
          <span>{props.memberCount.toLocaleString("en-US")}</span>
        </button>
      )}
    </header>
  );
}
