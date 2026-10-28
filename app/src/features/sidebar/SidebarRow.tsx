import type { JSX } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { Line } from "../../ui/Line";
import styles from "./SidebarRow.module.css";

export interface SidebarRowProps {
  readonly buffer: BufferProjection;
  readonly active: boolean;
  readonly muted?: boolean;
  readonly tabIndex: number;
  readonly onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  readonly onFocus?: JSX.EventHandler<HTMLButtonElement, FocusEvent>;
}

export function SidebarRow(props: SidebarRowProps) {
  return (
    <button
      aria-label={rowLabel(props.buffer)}
      aria-current={props.active ? "page" : undefined}
      class={`${styles.row} ${props.active ? styles.active : ""} ${
        props.muted === true ? styles.muted : ""
      } ${props.buffer.unread > 0 ? styles.unread : ""}`}
      data-buffer-id={props.buffer.id}
      data-muted={props.muted === true ? "true" : undefined}
      onClick={props.onClick}
      onFocus={props.onFocus}
      tabIndex={props.tabIndex}
      type="button"
    >
      <span aria-hidden="true" class={styles.kind}>
        {props.buffer.kind === "channel" ? "#" : "@"}
      </span>
      <Line class={styles.title}>{props.buffer.title.replace(/^#/, "")}</Line>
      {props.buffer.mentions > 0 ? (
        <Line class={styles.mention}>{props.buffer.mentions}</Line>
      ) : (
        props.buffer.unread > 0 && (
          <span aria-hidden="true" class={styles.dot} />
        )
      )}
    </button>
  );
}

function rowLabel(buffer: BufferProjection): string {
  if (buffer.mentions > 0) {
    return `${buffer.title}, ${buffer.mentions} mentions`;
  }
  if (buffer.unread > 0) return `${buffer.title}, ${buffer.unread} unread`;
  return buffer.title;
}
