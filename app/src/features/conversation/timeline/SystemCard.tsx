import { type JSX, Show } from "solid-js";
import type { LineEvent } from "../../../engine/generated/LineEvent";
import { t } from "../../../strings";
import { formatTime } from "../../../ui/format-time";
import { EventIcon } from "../../../ui/icons/EventIcon";
import styles from "./SystemCard.module.css";
import lineStyles from "./SystemLine.module.css";

export type TopicCardEvent = Extract<LineEvent, { type: "topic_card" }>;

export function SystemCard(props: {
  readonly card: TopicCardEvent;
  readonly presentation: "desktop" | "mobile";
  readonly renderText: (text: string) => JSX.Element;
  readonly timeMs: number;
}) {
  const meta = () => topicCardMeta(props.card);
  return (
    <section
      aria-label={topicCardAccessibleName(props.card)}
      class={lineStyles.line}
      data-presentation={props.presentation}
      data-system-card="topic"
    >
      <time
        class={lineStyles.time}
        dateTime={new Date(props.timeMs).toISOString()}
      >
        {formatTime(props.timeMs)}
      </time>
      <span class={`${lineStyles.iconColumn} ${styles.desktopIcon}`}>
        <EventIcon class={lineStyles.icon} icon="topic" />
      </span>
      <div class={styles.card}>
        <div class={styles.header}>
          <EventIcon class={styles.phoneIcon} icon="topic" />
          <span class={styles.title}>{t("messages.topic.title")}</span>
          <Show when={meta()}>
            <span class={styles.meta}>{meta()}</span>
          </Show>
        </div>
        <div class={styles.text} data-system-card-text="true">
          {props.card.topic === ""
            ? t("messages.topic.empty")
            : props.renderText(props.card.topic)}
        </div>
      </div>
    </section>
  );
}

export function topicCardMeta(card: TopicCardEvent): string {
  return [
    card.setter === null || card.setter === ""
      ? undefined
      : t("messages.topic.set_by", { setter: card.setter }),
    card.set_at_ms === null ? undefined : formatCardDate(card.set_at_ms),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

export function topicCardAccessibleName(card: TopicCardEvent): string {
  return [
    t("messages.topic.title"),
    card.topic === "" ? t("messages.topic.empty") : card.topic,
    topicCardMeta(card),
  ]
    .filter(Boolean)
    .join(". ");
}

const cardDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

function formatCardDate(milliseconds: number): string {
  return cardDateFormatter.format(milliseconds);
}
