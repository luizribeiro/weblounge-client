import type { JSX } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../features/composer/strings";
import { nickColor } from "../../features/conversation/nick-color";
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
  const message = () => props.buffer.last_message;
  const activityTime = () =>
    props.buffer.last_activity_ms ??
    message()?.server_time_ms ??
    message()?.received_at_ms;
  const visiblePreview = () =>
    props.buffer.cached_preview ?? preview(props.buffer);
  return (
    <button
      aria-label={props.buffer.title}
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
        <span class={styles.detail}>
          {props.previews && visiblePreview() !== "" && (
            <Line class={styles.preview}>{visiblePreview()}</Line>
          )}
          {props.buffer.mentions > 0 ? (
            <span
              aria-label={`${props.buffer.mentions} mentions`}
              class={styles.badge}
              role="status"
            >
              {props.buffer.mentions}
            </span>
          ) : (
            props.buffer.unread > 0 && (
              <span
                aria-label={`${props.buffer.unread} unread`}
                class={styles.unreadDot}
                role="status"
              />
            )
          )}
        </span>
      </span>
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
    return message.kind === "action" ? `* ${text}` : text;
  }
  return message.kind === "action"
    ? `* ${message.author} ${text}`
    : `${message.author}: ${text}`;
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
