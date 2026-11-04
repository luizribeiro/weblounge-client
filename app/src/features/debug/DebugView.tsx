import { For, type JSX } from "solid-js";
import { connectionStateKind } from "../../engine/connection-state";
import type {
  BufferProjection,
  MessageProjection,
  NetworkProjection,
} from "../../engine/protocol";
import { t } from "../../strings";
import type { CopyRow } from "../../ui/copy-rows";
import { copySelectedRows } from "../../ui/copy-selection";
import { Line } from "../../ui/Line";
import { Selectable } from "../../ui/Selectable";

interface DebugViewProps {
  networks: readonly NetworkProjection[];
  buffers: readonly BufferProjection[];
  messages: ReadonlyMap<number, readonly MessageProjection[]>;
  onSend: (bufferId: number, text: string) => void;
}

export function DebugView(props: DebugViewProps) {
  const send: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const bufferId = Number(form.get("buffer"));
    const text = String(form.get("message") ?? "");
    if (Number.isFinite(bufferId) && text !== "") {
      props.onSend(bufferId, text);
      event.currentTarget.reset();
    }
  };

  return (
    <section aria-label={t("debug.view")}>
      <h2>{t("debug.networks")}</h2>
      <ul>
        <For each={props.networks}>
          {(network) => (
            <li>
              <Line>
                {t("debug.network", {
                  label: network.label,
                  nickname: network.nickname,
                  state: t(
                    `sidebar.network_state.${connectionStateKind(network.state)}`,
                  ),
                })}
              </Line>
            </li>
          )}
        </For>
      </ul>
      <h2>{t("debug.buffers")}</h2>
      <For each={props.buffers}>
        {(buffer) => (
          <section data-buffer-title={buffer.title}>
            <h3>
              <Line>
                {t("debug.buffer_summary", {
                  title: buffer.title,
                  kind: buffer.kind,
                  unread: String(buffer.unread),
                  mentions: String(buffer.mentions),
                })}
              </Line>
            </h3>
            <ol
              data-message-list="true"
              onCopy={(event) =>
                copySelectedRows(
                  event,
                  event.currentTarget,
                  toCopyRows(props.messages.get(buffer.id) ?? []),
                )
              }
            >
              <For each={props.messages.get(buffer.id) ?? []}>
                {(message, index) => (
                  <li
                    data-copy-row-index={index()}
                    data-delivery={message.delivery}
                    data-message-row="true"
                    data-message-text={message.text}
                  >
                    <Selectable surfaceId={`message-${message.id}`}>
                      &lt;{message.author}&gt; {message.text}
                    </Selectable>{" "}
                    <span data-message-chrome="true">[{message.delivery}]</span>
                  </li>
                )}
              </For>
            </ol>
          </section>
        )}
      </For>
      <form onSubmit={send}>
        <label>
          {t("debug.buffer")}
          <select name="buffer">
            <For
              each={props.buffers.filter((buffer) => buffer.kind !== "server")}
            >
              {(buffer) => <option value={buffer.id}>{buffer.title}</option>}
            </For>
          </select>
        </label>
        <label>
          {t("debug.message")}
          <input name="message" />
        </label>
        <button type="submit">{t("common.send")}</button>
      </form>
    </section>
  );
}

function toCopyRows(messages: readonly MessageProjection[]): CopyRow[] {
  return messages.map((message) => ({
    kind: "message",
    time: new Date(message.server_time_ms ?? message.received_at_ms),
    author: message.author,
    text: message.text,
  }));
}
