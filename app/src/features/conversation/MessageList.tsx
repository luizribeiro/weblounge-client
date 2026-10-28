import { For } from "solid-js";
import type { MessageProjection } from "../../engine/protocol";
import { nickPaletteSize } from "../../theme/theme-registry";
import type { CopyRow } from "../../ui/copy-rows";
import { copySelectedRows } from "../../ui/copy-selection";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";
import styles from "./MessageList.module.css";

interface MessageListProps {
  readonly messages: readonly MessageProjection[];
}

export function MessageList(props: MessageListProps) {
  return (
    <ol
      class={styles.list}
      data-message-list="true"
      onCopy={(event) =>
        copySelectedRows(event, event.currentTarget, toCopyRows(props.messages))
      }
    >
      <For each={props.messages}>
        {(message, index) => (
          <li
            class={`${styles.row} ${message.mentioned ? styles.mentioned : ""}`}
            data-copy-row-index={index()}
            data-delivery={message.delivery}
            data-message-row="true"
            data-message-text={message.text}
          >
            <time
              class={styles.time}
              data-message-chrome="true"
              dateTime={new Date(
                message.server_time_ms ?? message.received_at_ms,
              ).toISOString()}
            >
              <Line>{formatTime(message)}</Line>
            </time>
            <Line
              class={`${styles.nick} ${
                message.authorship === "own" ? styles.own : ""
              }`}
              data-message-chrome="true"
              style={
                message.authorship === "own"
                  ? undefined
                  : {
                      color: `var(--wl-nick-${message.nick_color_index % nickPaletteSize})`,
                    }
              }
            >
              {message.author}
            </Line>
            <Selectable class={styles.text} surfaceId={`message-${message.id}`}>
              {message.text}
            </Selectable>
            {message.delivery === "optimistic" && (
              <Line class={styles.pending} data-message-chrome="true">
                Sending…
              </Line>
            )}
            {message.delivery === "failed" && (
              <Line class={styles.failed} data-message-chrome="true">
                Failed
              </Line>
            )}
          </li>
        )}
      </For>
    </ol>
  );
}

function formatTime(message: MessageProjection): string {
  const time = new Date(message.server_time_ms ?? message.received_at_ms);
  return `${time.getHours().toString().padStart(2, "0")}:${time
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function toCopyRows(messages: readonly MessageProjection[]): CopyRow[] {
  return messages.map((message) => ({
    kind: "message",
    time: new Date(message.server_time_ms ?? message.received_at_ms),
    author: message.author,
    text: message.text,
  }));
}
