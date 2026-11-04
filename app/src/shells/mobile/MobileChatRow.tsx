import type { JSX } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { nickColor } from "../../features/conversation/nick-color";
import { unreadBadge } from "../../features/unread/unread-badge";
import { t } from "../../strings";
import { formatTime } from "../../ui/format-time";
import { Line } from "../../ui/Line";
import styles from "./MobileChatRow.module.css";

const previewLength = 80;

interface MobileChatRowProps {
  readonly buffer: BufferProjection;
  readonly networkLabel?: string | undefined;
  readonly previews: boolean;
  readonly onOpen: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onPressStart?:
    | JSX.EventHandler<HTMLButtonElement, PointerEvent>
    | undefined;
}

export function MobileChatRow(props: MobileChatRowProps) {
  const badge = () => unreadBadge(props.buffer);
  const message = () => props.buffer.last_message;
  const activityTime = () =>
    props.buffer.last_activity_ms ??
    message()?.server_time_ms ??
    message()?.received_at_ms;
  const visiblePreview = () =>
    props.buffer.cached_preview ?? preview(props.buffer);
  return (
    <button
      aria-label={
        badge() === undefined
          ? props.buffer.title
          : t("sidebar.row_label", {
              title: props.buffer.title,
              badge: badge()?.label ?? "",
            })
      }
      class={styles.row}
      data-buffer-id={props.buffer.id}
      data-cached={props.buffer.cached || undefined}
      onClick={props.onOpen}
      onPointerDown={props.onPressStart}
      type="button"
    >
      <span
        aria-hidden="true"
        class={styles.avatar}
        data-nick-color-index={props.buffer.nick_color_index}
        style={
          props.buffer.kind === "direct" &&
          props.buffer.nick_color_index !== undefined
            ? { color: nickColor(props.buffer.nick_color_index) }
            : undefined
        }
      >
        {props.buffer.kind === "channel"
          ? "#"
          : props.buffer.title.slice(0, 1).toUpperCase()}
      </span>
      <span class={styles.content}>
        <span class={styles.heading}>
          <Line class={styles.title}>{props.buffer.title}</Line>
          {props.networkLabel !== undefined && (
            <Line class={styles.network}>{props.networkLabel}</Line>
          )}
          {activityTime() !== undefined && (
            <time class={styles.time} dateTime={dateTime(activityTime())}>
              {formatTime(activityTime() ?? 0)}
            </time>
          )}
        </span>
        {props.previews && visiblePreview() !== "" && (
          <span class={styles.detail}>
            <Line class={styles.preview}>{visiblePreview()}</Line>
          </span>
        )}
      </span>
      {badge() !== undefined && (
        <span
          aria-label={badge()?.label}
          class={`${styles.badge} ${
            badge()?.kind === "mention" ? styles.mention : ""
          }`}
          data-badge-kind={badge()?.kind}
          role="status"
        >
          {badge()?.count}
        </span>
      )}
    </button>
  );
}

function preview(buffer: BufferProjection): string {
  const message = buffer.last_message;
  if (message === undefined) return "";
  const text = excerpt(message.text);
  if (buffer.kind === "direct" && message.authorship === "own") {
    return t("mobile.preview.own", { text });
  }
  if (buffer.kind === "direct" && message.author === buffer.title) {
    return message.kind === "action"
      ? t("mobile.preview.direct_action", { text })
      : text;
  }
  return message.kind === "action"
    ? t("mobile.preview.action", { author: message.author, text })
    : t("mobile.preview.message", { author: message.author, text });
}

function excerpt(text: string): string {
  const characters = [...text];
  return characters.length > previewLength
    ? `${characters.slice(0, previewLength).join("")}…`
    : text;
}

function dateTime(milliseconds = 0): string {
  return new Date(milliseconds).toISOString();
}
