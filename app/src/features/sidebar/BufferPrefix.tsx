import { type JSX, splitProps } from "solid-js";
import type { BufferProjection } from "../../engine/protocol";
import { PresenceMark } from "../../ui/PresenceMark";
import styles from "./BufferPrefix.module.css";

interface BufferPrefixProps
  extends Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly buffer: BufferProjection;
}

export function BufferPrefix(props: BufferPrefixProps) {
  const [own, rest] = splitProps(props, ["buffer", "class"]);
  const sign = () =>
    own.buffer.kind === "channel" ? own.buffer.title.slice(0, 1) : "";
  return (
    <span
      {...rest}
      aria-hidden="true"
      class={`${styles.prefix} ${own.class ?? ""}`}
    >
      {sign() !== "" && <span data-channel-sign="true">{sign()}</span>}
      <PresenceMark
        bot={own.buffer.peer_bot === true}
        class={styles.mark}
        presence={own.buffer.peer_presence}
      />
    </span>
  );
}
