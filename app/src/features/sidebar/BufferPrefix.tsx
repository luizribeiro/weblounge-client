import { type JSX, splitProps } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { BotIcon } from "../../ui/BotIcon";
import styles from "./BufferPrefix.module.css";

interface BufferPrefixProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly buffer: BufferProjection;
}

export function BufferPrefix(props: BufferPrefixProps) {
  const [own, rest] = splitProps(props, ["buffer", "class"]);
  const sign = () =>
    own.buffer.kind === "channel" ? own.buffer.title.slice(0, 1) : "";
  const presence = () => own.buffer.peer_presence;
  return (
    <span
      {...rest}
      aria-hidden="true"
      class={`${styles.prefix} ${own.class ?? ""}`}
    >
      {sign() !== "" && <span data-channel-sign="true">{sign()}</span>}
      {own.buffer.peer_bot === true ? (
        <BotIcon
          class={styles.bot}
          data-peer-bot="true"
          data-presence={presence()}
        />
      ) : (
        presence() !== undefined && (
          <span
            class={styles.presence}
            data-presence={presence()}
            data-presence-dot="true"
          />
        )
      )}
    </span>
  );
}
