import { type JSX, Show } from "solid-js";
import { formatTime } from "../../../ui/format-time";
import { EventIcon, type EventIconName } from "../../../ui/icons/EventIcon";
import styles from "./SystemCard.module.css";
import lineStyles from "./SystemLine.module.css";

export function SystemCard(props: {
  readonly accessibleName: string;
  readonly children: JSX.Element;
  readonly icon: EventIconName;
  readonly kind: "topic";
  readonly meta?: string | undefined;
  readonly presentation: "desktop" | "mobile";
  readonly timeMs: number;
  readonly title: string;
}) {
  return (
    <section
      aria-label={props.accessibleName}
      class={lineStyles.line}
      data-presentation={props.presentation}
      data-system-card={props.kind}
    >
      <time
        class={lineStyles.time}
        dateTime={new Date(props.timeMs).toISOString()}
      >
        {formatTime(props.timeMs)}
      </time>
      <span class={`${lineStyles.iconColumn} ${styles.desktopIcon}`}>
        <EventIcon class={lineStyles.icon} icon={props.icon} />
      </span>
      <div class={styles.card}>
        <div class={styles.header}>
          <EventIcon class={styles.phoneIcon} icon={props.icon} />
          <span class={styles.title}>{props.title}</span>
          <Show when={props.meta}>
            <span class={styles.meta}>{props.meta}</span>
          </Show>
        </div>
        {props.children}
      </div>
    </section>
  );
}
