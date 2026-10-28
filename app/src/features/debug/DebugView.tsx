import { For, type JSX } from "solid-js";
import type {
  BufferProjection,
  MessageProjection,
  NetworkProjection,
} from "../../engine/protocol";

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
    <section aria-label="Temporary engine debug view">
      <h2>Networks</h2>
      <ul>
        <For each={props.networks}>
          {(network) => (
            <li>
              {network.label}: {network.nickname} ({network.state})
            </li>
          )}
        </For>
      </ul>
      <h2>Buffers</h2>
      <For each={props.buffers}>
        {(buffer) => (
          <section>
            <h3>
              {buffer.title} ({buffer.kind}, {buffer.unread} unread,{" "}
              {buffer.mentions} mentions)
            </h3>
            <ol>
              <For each={props.messages.get(buffer.id) ?? []}>
                {(message) => (
                  <li
                    data-delivery={message.delivery}
                    data-message-text={message.text}
                  >
                    &lt;{message.author}&gt; {message.text} [{message.delivery}]
                  </li>
                )}
              </For>
            </ol>
          </section>
        )}
      </For>
      <form onSubmit={send}>
        <label>
          Buffer
          <select name="buffer">
            <For
              each={props.buffers.filter((buffer) => buffer.kind !== "server")}
            >
              {(buffer) => <option value={buffer.id}>{buffer.title}</option>}
            </For>
          </select>
        </label>
        <label>
          Message
          <input name="message" />
        </label>
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
