import { type JSX, onCleanup } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { t } from "../../strings";
import {
  type ContextMenuRequest,
  contextMenuRegistry,
} from "../../ui/context-menu";
import { Line } from "../../ui/Line";
import { unreadBadge } from "../unread/unread-badge";
import styles from "./SidebarRow.module.css";

export interface SidebarRowProps {
  readonly buffer: BufferProjection;
  readonly active: boolean;
  readonly badgesSuppressed?: boolean;
  readonly muted?: boolean;
  readonly tabIndex: number;
  readonly onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onFocus?: JSX.EventHandler<HTMLButtonElement, FocusEvent>;
  readonly onOpenMenu?: (request: ContextMenuRequest) => void;
  readonly ref?: (element: HTMLButtonElement) => void;
}

export function SidebarRow(props: SidebarRowProps) {
  let unregisterContextSurface = () => {};
  onCleanup(() => unregisterContextSurface());
  const showBadges = () => props.badgesSuppressed !== true;
  const badge = () => (showBadges() ? unreadBadge(props.buffer) : undefined);
  const visibleUnread = () => (showBadges() ? props.buffer.unread : 0);
  const visibleMentions = () => (showBadges() ? props.buffer.mentions : 0);
  const prefix = () =>
    props.buffer.kind === "channel" ? props.buffer.title.slice(0, 1) : "";
  const name = () =>
    props.buffer.kind === "channel"
      ? props.buffer.title.slice(1)
      : props.buffer.title;
  return (
    <button
      aria-label={rowLabel(props.buffer.title, badge()?.label)}
      aria-current={props.active ? "page" : undefined}
      class={`${styles.row} ${props.active ? styles.active : ""} ${
        props.muted === true ? styles.muted : ""
      } ${visibleUnread() > 0 ? styles.unread : ""}`}
      data-buffer-id={props.buffer.id}
      data-mentions={visibleMentions()}
      data-muted={props.muted === true ? "true" : undefined}
      data-unread={visibleUnread()}
      onClick={props.onClick}
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
      <span aria-hidden="true" class={styles.prefix} data-sidebar-prefix="true">
        {prefix()}
      </span>
      <Line
        class={styles.title}
        data-sidebar-name="true"
        title={props.buffer.title}
      >
        {name()}
      </Line>
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
    </button>
  );
}

function rowLabel(title: string, badgeLabel: string | undefined): string {
  return badgeLabel === undefined
    ? title
    : t("sidebar.row_label", { title, badge: badgeLabel });
}
