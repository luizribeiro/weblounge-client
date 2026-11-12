import { createEffect, createSignal, type JSX, onCleanup } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { nickColor } from "../../features/conversation/nick-color";
import { unreadBadge } from "../../features/unread/unread-badge";
import { t } from "../../strings";
import { formatTime } from "../../ui/format-time";
import { Line } from "../../ui/Line";
import styles from "./MobileChatRow.module.css";
import {
  beginMobileRowSwipe,
  cancelledMobileRowSwipe,
  type MobileRowSwipeState,
  mobileRowActionWidth,
  moveMobileRowSwipe,
  releaseMobileRowSwipe,
} from "./mobile-row-swipe";

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
  readonly onRequestActions?:
    | ((rect: DOMRect, invoker: HTMLButtonElement) => void)
    | undefined;
}

export function MobileChatRow(props: MobileChatRowProps) {
  let wrapper: HTMLDivElement | undefined;
  let rowButton: HTMLButtonElement | undefined;
  let pointerId: number | undefined;
  let swipe: MobileRowSwipeState = { phase: "idle", revealed: false };
  let longPressTimer: number | undefined;
  let lastX = 0;
  let lastTime = 0;
  let suppressClick = false;
  const [offset, setOffset] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [revealed, setRevealed] = createSignal(false);
  const clearLongPress = () => {
    if (longPressTimer !== undefined) window.clearTimeout(longPressTimer);
    longPressTimer = undefined;
  };
  const settle = (endpoint: "reveal" | "reset") => {
    setDragging(false);
    setRevealed(endpoint === "reveal");
    setOffset(endpoint === "reveal" ? mobileRowActionWidth : 0);
    swipe = { phase: "idle", revealed: endpoint === "reveal" };
    if (endpoint === "reveal") props.onReveal?.();
    else props.onReset?.();
  };
  const cancelGesture = () => {
    if (pointerId === undefined) return;
    clearLongPress();
    pointerId = undefined;
    settle(cancelledMobileRowSwipe(swipe));
  };
  const requestActions = () => {
    if (rowButton === undefined) return;
    props.onRequestActions?.(
      wrapper?.getBoundingClientRect() ?? new DOMRect(),
      rowButton,
    );
  };
  createEffect(() => {
    if (dragging()) return;
    const next = props.revealed === true;
    setRevealed(next);
    setOffset(next ? mobileRowActionWidth : 0);
  });
  const onVisibility = () => {
    if (document.visibilityState === "hidden") cancelGesture();
  };
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => {
    clearLongPress();
    document.removeEventListener("visibilitychange", onVisibility);
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
      data-swipe-state={
        dragging() ? "dragging" : revealed() ? "revealed" : "closed"
      }
      onLostPointerCapture={cancelGesture}
      onPointerCancel={cancelGesture}
      onPointerDown={(event) => {
        if (event.isPrimary === false || event.button !== 0) return;
        props.onPressStart?.(event);
        pointerId = event.pointerId;
        lastX = event.clientX;
        lastTime = event.timeStamp;
        swipe = beginMobileRowSwipe(
          props.buffer.kind === "channel" ? "channel" : "direct",
          event.currentTarget.getBoundingClientRect().width,
          event.clientX,
          event.clientY,
          revealed(),
        );
        clearLongPress();
        if (!revealed()) {
          // wait-ok: this is the product's fixed long-press recognition window.
          longPressTimer = window.setTimeout(() => {
            longPressTimer = undefined;
            if (pointerId === undefined || swipe.phase !== "tracking") return;
            suppressClick = true;
            pointerId = undefined;
            settle("reset");
            requestActions();
          }, 500);
        }
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointerId) return;
        const next = moveMobileRowSwipe(swipe, event.clientX, event.clientY);
        swipe = next;
        if (next.phase === "cancelled") {
          clearLongPress();
          return;
        }
        if (next.phase !== "dragging") return;
        clearLongPress();
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragging(true);
        setOffset(next.offset);
        lastX = event.clientX;
        lastTime = event.timeStamp;
      }}
      onPointerUp={(event) => {
        if (event.pointerId !== pointerId) return;
        clearLongPress();
        pointerId = undefined;
        const elapsed = event.timeStamp - lastTime;
        const velocity = elapsed > 0 ? (event.clientX - lastX) / elapsed : 0;
        const result = releaseMobileRowSwipe(swipe, velocity);
        if (result === "tap") {
          if (revealed()) {
            suppressClick = true;
            settle("reset");
          }
          return;
        }
        suppressClick = true;
        if (result === "close") {
          setDragging(false);
          setOffset(event.currentTarget.getBoundingClientRect().width);
          void Promise.resolve(props.onRequestClose?.()).then((closed) => {
            if (closed === false) settle("reset");
          });
        } else {
          settle(result);
        }
      }}
      ref={wrapper}
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
        aria-haspopup="dialog"
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
        onClick={(event) => {
          if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            return;
          }
          props.onOpen(event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          requestActions();
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          )
            return;
          event.preventDefault();
          requestActions();
        }}
        ref={rowButton}
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
