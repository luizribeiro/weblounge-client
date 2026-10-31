import { createMemo, For, Match, Switch } from "solid-js";
import styles from "./MessageList.module.css";
import { tokenizeMessage } from "./message-tokenizer";
import { nickColor } from "./nick-color";
import type { NickDisplay } from "./nick-lookup";

interface MessageTextProps {
  readonly authors: ReadonlyMap<string, NickDisplay>;
  readonly text: string;
  readonly onOpenChannel?: ((channel: string) => void) | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
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
              <Nickname
                display={props.authors.get(token.value.toLocaleLowerCase())}
                onOpenDirect={props.onOpenDirect}
                value={token.value}
              />
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

export function Nickname(props: {
  readonly class?: string | undefined;
  readonly display: NickDisplay | undefined;
  readonly onOpenDirect?: ((nick: string) => void) | undefined;
  readonly title?: string | undefined;
  readonly value: string;
}) {
  const own = () => props.display?.authorship === "own";
  const clickable = () =>
    props.display !== undefined && !own() && props.onOpenDirect !== undefined;
  const className = () =>
    [
      props.class,
      own() ? styles.own : undefined,
      clickable() ? styles.nickAction : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  const style = () =>
    own() || props.display === undefined
      ? undefined
      : { color: nickColor(props.display.nick_color_index) };

  if (clickable())
    return (
      <button
        aria-label={`Open direct message with ${props.value}`}
        class={className()}
        data-nick-action="true"
        onClick={() => props.onOpenDirect?.(props.value)}
        style={style()}
        title={props.title}
        type="button"
      >
        {props.value}
      </button>
    );

  return (
    <span class={className()} style={style()} title={props.title}>
      {props.value}
    </span>
  );
}
