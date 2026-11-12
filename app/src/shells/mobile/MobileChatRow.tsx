import { createEffect, createSignal, type JSX } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { nickColor } from "../../features/conversation/nick-color";
import { unreadBadge } from "../../features/unread/unread-badge";
import { t } from "../../strings";
import { formatTime } from "../../ui/format-time";
import { Line } from "../../ui/Line";
import styles from "./MobileChatRow.module.css";

interface MobileChatRowProps {
  readonly buffer: BufferProjection;
  readonly networkLabel?: string | undefined;
  readonly previews: boolean;
  readonly onOpen: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onPressStart?:
    | JSX.EventHandler<HTMLDivElement, PointerEvent>
    | undefined;
  readonly revealed?: boolean | undefined;
  readonly onReveal?: (() => void) | undefined;
  readonly onReset?: (() => void) | undefined;
  readonly onMarkRead?: (() => void) | undefined;
  readonly onRequestClose?:
    | (() => boolean | Promise<boolean> | void)
    | undefined;
}

export function MobileChatRow(props: MobileChatRowProps) {
  const [offset, setOffset] = createSignal(0);
  const [revealed, setRevealed] = createSignal(false);
  const settle = (endpoint: "reveal" | "reset") => {
    setRevealed(endpoint === "reveal");
    setOffset(endpoint === "reveal" ? 148 : 0);
    if (endpoint === "reveal") props.onReveal?.();
    else props.onReset?.();
  };
  createEffect(() => {
    const next = props.revealed === true;
    setRevealed(next);
    setOffset(next ? 148 : 0);
  });
  const badge = () => unreadBadge(props.buffer);
  const message = () => props.buffer.last_message;
  const activityTime = () =>
    props.buffer.last_activity_ms ??
    message()?.server_time_ms ??
    message()?.received_at_ms;
  const visiblePreview = () => props.buffer.preview ?? "";
  return (
    <div
      class={styles.wrapper}
      data-mobile-row-wrapper={props.buffer.id}
      data-swipe-state={revealed() ? "revealed" : "closed"}
      onPointerDown={props.onPressStart}
      style={{ "--wl-mobile-row-offset": `${offset()}px` }}
    >
      <span
        aria-hidden={!revealed() || undefined}
        class={styles.actions}
        data-mobile-row-actions="true"
        inert={!revealed()}
      >
        <button
          class={styles.readAction}
          onClick={() => {
            settle("reset");
            props.onMarkRead?.();
          }}
          type="button"
        >
          <span aria-hidden="true">✓</span>
          {t("mobile.action.read")}
        </button>
        <button
          class={styles.closeAction}
          onClick={() => {
            settle("reset");
            props.onRequestClose?.();
          }}
          type="button"
        >
          <span aria-hidden="true">
            {props.buffer.kind === "channel" ? "↤" : "×"}
          </span>
          {props.buffer.kind === "channel"
            ? t("mobile.action.leave")
            : t("mobile.action.close")}
        </button>
      </span>
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
        onClick={props.onOpen}
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
    </div>
  );
}

function dateTime(milliseconds = 0): string {
  return new Date(milliseconds).toISOString();
}
