import type { JSX } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./SidebarRow.module.css";

export interface SidebarRowProps {
  readonly buffer: BufferProjection;
  readonly active: boolean;
  readonly badgesSuppressed?: boolean;
  readonly muted?: boolean;
  readonly tabIndex: number;
  readonly onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onFocus?: JSX.EventHandler<HTMLButtonElement, FocusEvent>;
  readonly ref?: (element: HTMLButtonElement) => void;
}

export function SidebarRow(props: SidebarRowProps) {
  const showBadges = () => props.badgesSuppressed !== true;
  return (
    <button
      aria-label={rowLabel(props.buffer, showBadges())}
      aria-current={props.active ? "page" : undefined}
      class={`${styles.row} ${props.active ? styles.active : ""} ${
        props.muted === true ? styles.muted : ""
      } ${showBadges() && props.buffer.unread > 0 ? styles.unread : ""}`}
      data-buffer-id={props.buffer.id}
      data-mentions={props.buffer.mentions}
      data-muted={props.muted === true ? "true" : undefined}
      data-unread={props.buffer.unread}
      onClick={props.onClick}
      onFocus={props.onFocus}
      ref={props.ref}
      tabIndex={props.tabIndex}
      type="button"
    >
      <Line class={styles.title} data-sidebar-name="true">
        {props.buffer.title}
      </Line>
      {showBadges() && props.buffer.mentions > 0 ? (
        <Line class={styles.mention}>{props.buffer.mentions}</Line>
      ) : (
        showBadges() &&
        props.buffer.unread > 0 && (
          <span aria-hidden="true" class={styles.dot} />
        )
      )}
    </button>
  );
}

function rowLabel(buffer: BufferProjection, showBadges: boolean): string {
  if (!showBadges) return buffer.title;
  if (buffer.mentions > 0) {
    return `${buffer.title}, ${buffer.mentions} mentions`;
  }
  if (buffer.unread > 0) return `${buffer.title}, ${buffer.unread} unread`;
  return buffer.title;
}
