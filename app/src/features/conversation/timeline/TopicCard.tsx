import type { JSX } from "solid-js";
import type { LineEvent } from "../../../engine/generated/LineEvent";
import { t } from "../../../strings";
import { formatShortDate } from "../../../ui/format-time";
import { Selectable } from "../../../ui/Selectable";
import { SystemCard } from "./SystemCard";
import styles from "./SystemCard.module.css";

export type TopicCardEvent = Extract<LineEvent, { type: "topic_card" }>;

export function TopicCard(props: {
  readonly card: TopicCardEvent;
  readonly presentation: "desktop" | "mobile";
  readonly renderText: (text: string) => JSX.Element;
  readonly timeMs: number;
}) {
  return (
    <SystemCard
      accessibleName={topicCardAccessibleName(props.card)}
      icon="topic"
      kind="topic"
      meta={topicCardMeta(props.card)}
      presentation={props.presentation}
      timeMs={props.timeMs}
      title={t("messages.topic.title")}
    >
      <div class={styles.text} data-system-card-text="true">
        <Selectable surfaceId="topic-card-text">
          {props.card.topic === ""
            ? t("messages.topic.empty")
            : props.renderText(props.card.topic)}
        </Selectable>
      </div>
    </SystemCard>
  );
}

export function topicCardMeta(card: TopicCardEvent): string {
  return [
    card.setter === null || card.setter === ""
      ? undefined
      : t("messages.topic.set_by", { setter: card.setter }),
    card.set_at_ms === null ? undefined : formatShortDate(card.set_at_ms),
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
