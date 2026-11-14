import { createSignal, type JSX, onCleanup } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../strings";
import { BotIcon } from "../../ui/BotIcon";
import {
  type ContextMenuRequest,
  contextMenuRegistry,
} from "../../ui/context-menu";
import { Line } from "../../ui/Line";
import { unreadBadge } from "../unread/unread-badge";
import styles from "./SidebarRow.module.css";
import { trailingSlot } from "./trailing-slot";

export interface SidebarRowProps {
  readonly buffer: BufferProjection;
  readonly active: boolean;
  readonly badgesSuppressed?: boolean;
  readonly jumpSlot?: number | undefined;
  readonly jumpHintShown?: boolean;
  readonly muted?: boolean;
  readonly tabIndex: number;
  readonly onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onFocus?: JSX.EventHandler<HTMLButtonElement, FocusEvent>;
  readonly onClose?: (() => void) | undefined;
  readonly onOpenMenu?: (request: ContextMenuRequest) => void;
  readonly ref?: (element: HTMLButtonElement) => void;
}

export function SidebarRow(props: SidebarRowProps) {
  let unregisterContextSurface = () => {};
  onCleanup(() => unregisterContextSurface());
  const showBadges = () => props.badgesSuppressed !== true;
  const badge = () => (showBadges() ? unreadBadge(props.buffer) : undefined);
  const [pointerInside, setPointerInside] = createSignal(false);
  const [focusInside, setFocusInside] = createSignal(false);
  const closable = () => props.onClose !== undefined;
  const copy = () => closeCopy(props.buffer);
  const middleClickClose = {
    onAuxClick: (event: MouseEvent) => {
      if (!isMiddleButton(event)) return;
      event.preventDefault();
      if (!dragInProgress(event)) props.onClose?.();
    },
    onMouseDown: (event: MouseEvent) => {
      if (isMiddleButton(event)) event.preventDefault();
    },
  };
  const slot = () =>
    trailingSlot({
      badge: badge() !== undefined,
      closable: closable(),
      engaged: pointerInside() || focusInside(),
      hint: props.jumpHintShown === true && props.jumpSlot !== undefined,
    });
  const visibleUnread = () => (showBadges() ? props.buffer.unread : 0);
  const visibleMentions = () => (showBadges() ? props.buffer.mentions : 0);
  const prefix = () =>
    props.buffer.kind === "channel" ? props.buffer.title.slice(0, 1) : "";
  const presence = () => props.buffer.peer_presence;
  const name = () =>
    props.buffer.kind === "channel"
      ? props.buffer.title.slice(1)
      : props.buffer.title;
  return (
    <div
      class={`${styles.row} ${props.active ? styles.active : ""} ${
        props.muted === true ? styles.muted : ""
      } ${visibleUnread() > 0 ? styles.unread : ""}`}
      data-sidebar-row="true"
      data-trailing={slot()}
      onFocusIn={() => setFocusInside(true)}
      onFocusOut={(event) =>
        setFocusInside(
          event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget),
        )
      }
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
    >
      <button
        aria-label={rowLabel(props.buffer, badge()?.label)}
        aria-current={props.active ? "page" : undefined}
        class={styles.open}
        data-buffer-id={props.buffer.id}
        data-mentions={visibleMentions()}
        data-muted={props.muted === true ? "true" : undefined}
        data-unread={visibleUnread()}
        onClick={props.onClick}
        {...middleClickClose}
        onFocus={props.onFocus}
        ref={(element) => {
          props.ref?.(element);
          unregisterContextSurface();
          unregisterContextSurface = contextMenuRegistry.register(element, {
            id: `sidebar-buffer-${props.buffer.id}`,
            kind: "chrome",
            ...(props.onOpenMenu === undefined
              ? {}
              : { openMenu: props.onOpenMenu }),
          });
        }}
        tabIndex={props.tabIndex}
        type="button"
      >
        <span
          aria-hidden="true"
          class={styles.prefix}
          data-sidebar-prefix="true"
        >
          {prefix()}
          {props.buffer.peer_bot === true ? (
            <BotIcon
              class={styles.peerBot}
              data-peer-bot="true"
              data-presence={presence()}
            />
          ) : (
            presence() !== undefined && (
              <span class={styles.presence} data-presence={presence()} />
            )
          )}
        </span>
        <Line
          class={styles.title}
          data-sidebar-name="true"
          title={props.buffer.title}
        >
          {name()}
        </Line>
        <span class={styles.slot} data-sidebar-slot="true">
          {badge() !== undefined && (
            <Line
              aria-label={badge()?.label}
              class={`${styles.badge} ${
                badge()?.kind === "mention" ? styles.mention : ""
              }`}
              data-badge-kind={badge()?.kind}
              role="status"
            >
              {badge()?.count}
            </Line>
          )}
          {props.jumpSlot !== undefined && (
            <span
              aria-hidden="true"
              class={styles.hint}
              data-jump-hint={props.jumpSlot}
            />
          )}
        </span>
      </button>
      {closable() && (
        <button
          aria-label={copy().label}
          class={styles.close}
          onClick={props.onClose}
          {...middleClickClose}
          tabIndex={-1}
          title={copy().tooltip}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 12 12">
            <path d="m3 3 6 6M9 3 3 9" />
          </svg>
        </button>
      )}
    </div>
  );
}

function isMiddleButton(event: MouseEvent): boolean {
  return event.button === 1;
}

function dragInProgress(event: MouseEvent): boolean {
  return event.buttons !== 0;
}

function closeCopy(buffer: BufferProjection): {
  readonly label: string;
  readonly tooltip: string;
} {
  if (buffer.kind === "channel") {
    // Name lookups (Playwright getByRole, screen-reader find) substring-match, so a × named after the channel would shadow its row.
    const leave = t("cmd.part.menu");
    return { label: leave, tooltip: leave };
  }
  return {
    label: t("sidebar.close_conversation", { title: buffer.title }),
    tooltip: t("cmd.close.menu"),
  };
}

function rowLabel(
  buffer: BufferProjection,
  badgeLabel: string | undefined,
): string {
  const presence = buffer.peer_presence;
  const title = rowTitleLabel(buffer);
  const label =
    badgeLabel === undefined
      ? title
      : t("sidebar.row_label", { title, badge: badgeLabel });
  return presence === undefined
    ? label
    : t("sidebar.row_presence_label", {
        label,
        presence: t(`sidebar.presence.${presence}`),
      });
}

function rowTitleLabel(buffer: BufferProjection): string {
  return buffer.peer_bot === true
    ? t("sidebar.row_bot_label", {
        title: buffer.title,
        bot: t("common.bot_icon"),
      })
    : buffer.title;
}
