import type { JSX } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../features/composer/strings";
import { formatTime } from "../../ui/format-time";
import { Line } from "../../ui/Line";
import styles from "./MobileChatRow.module.css";

interface MobileChatRowProps {
  readonly buffer: BufferProjection;
  readonly networkLabel?: string | undefined;
  readonly previews: boolean;
  readonly onOpen: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
}

export function MobileChatRow(props: MobileChatRowProps) {
  const message = () => props.buffer.last_message;
  const badge = () => props.buffer.mentions || props.buffer.unread;
  const badgeKind = () => (props.buffer.mentions > 0 ? "mentions" : "unread");
  return (
    <button
      aria-label={props.buffer.title}
      class={styles.row}
      data-buffer-id={props.buffer.id}
      onClick={props.onOpen}
      type="button"
    >
      <span aria-hidden="true" class={styles.avatar}>
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
          {message() !== undefined && (
            <time
              class={styles.time}
              dateTime={dateTime(message()?.received_at_ms)}
            >
              {formatTime(
                message()?.server_time_ms ?? message()?.received_at_ms ?? 0,
              )}
            </time>
          )}
        </span>
        <span class={styles.detail}>
          {props.previews && message() !== undefined && (
            <Line class={styles.preview}>{preview(props.buffer)}</Line>
          )}
          {badge() > 0 && (
            <span
              aria-label={`${badge()} ${badgeKind()}`}
              class={styles.badge}
              role="status"
            >
              {badge()}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

function preview(buffer: BufferProjection): string {
  const message = buffer.last_message;
  if (message === undefined) return "";
  if (buffer.kind === "direct" && message.authorship === "own") {
    return t("mobile.preview.own", { text: message.text });
  }
  if (buffer.kind === "direct" && message.author === buffer.title) {
    return message.kind === "action" ? `* ${message.text}` : message.text;
  }
  return message.kind === "action"
    ? `* ${message.author} ${message.text}`
    : `${message.author}: ${message.text}`;
}

function dateTime(milliseconds = 0): string {
  return new Date(milliseconds).toISOString();
}
