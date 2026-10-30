import { createMemo, For, Match, Switch } from "solid-js";
import styles from "./MessageList.module.css";
import { tokenizeMessage } from "./message-tokenizer";
import { nickColor } from "./nick-color";
import type { NickDisplay } from "./nick-lookup";

interface MessageTextProps {
  readonly authors: ReadonlyMap<string, NickDisplay>;
  readonly text: string;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenExternal?: ((href: string) => void) | undefined;
}

export function MessageText(props: MessageTextProps) {
  const tokens = createMemo(() =>
    tokenizeMessage(props.text, props.authors.keys()),
  );
  return (
    <For each={tokens()}>
      {(token) => (
        <Switch>
          <Match when={token.kind === "text"}>{token.value}</Match>
          <Match when={token.kind === "nick"}>
            {token.kind === "nick" && (
              <Nick authors={props.authors} value={token.value} />
            )}
          </Match>
          <Match when={token.kind === "channel"}>
            {token.kind === "channel" && (
              <a
                class={styles.messageLink}
                href={token.value}
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpenChannel?.(token.value);
                }}
              >
                {token.value}
              </a>
            )}
          </Match>
          <Match when={token.kind === "link"}>
            {token.kind === "link" && (
              <a
                class={styles.messageLink}
                href={token.href}
                onClick={(event) => {
                  if (props.onOpenExternal === undefined) return;
                  event.preventDefault();
                  props.onOpenExternal(token.href);
                }}
                rel="noopener noreferrer"
                target="_blank"
              >
                {token.value}
              </a>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}

function Nick(props: {
  readonly authors: ReadonlyMap<string, NickDisplay>;
  readonly value: string;
}) {
  const author = () => props.authors.get(props.value.toLocaleLowerCase());
  return (
    <span
      class={author()?.authorship === "own" ? styles.own : undefined}
      style={
        author()?.authorship === "own" || author() === undefined
          ? undefined
          : { color: nickColor(author()?.nick_color_index ?? 0) }
      }
    >
      {props.value}
    </span>
  );
}
