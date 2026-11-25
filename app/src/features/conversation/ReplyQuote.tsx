import { Match, Switch } from "solid-js";
import type { MessageId } from "../../engine/generated/MessageId";
import type { ReplyParent } from "../../engine/generated/ReplyParent";
import { type MessageKey, t } from "../../strings";
import { ReplyIcon } from "../../ui/icons/ReplyIcon";
import { nickColor } from "./nick-color";
import styles from "./ReplyQuote.module.css";

type ParentIn<State extends ReplyParent["state"]> = Extract<
  ReplyParent,
  { state: State }
>;
type MissingParent = ParentIn<"loading" | "deleted" | "unavailable">;

const missingParentText: Record<MissingParent["state"], MessageKey> = {
  loading: "reply.parent_loading",
  deleted: "reply.parent_deleted",
  unavailable: "reply.parent_unavailable",
};

/** One line above a reply naming its parent; only a loaded parent can be jumped to. */
export function ReplyQuote(props: {
  readonly class?: string | undefined;
  readonly parent: ReplyParent;
  readonly onJump: (messageId: MessageId) => void;
}) {
  const quoteAttributes = () => ({
    class: `${styles.quote} ${props.class ?? ""}`,
    "data-message-chrome": "true",
    "data-reply-quote": props.parent.state,
  });
  return (
    <Switch>
      <Match when={parentIn(props.parent, ["loaded"])}>
        {(parent) => (
          <button
            {...quoteAttributes()}
            aria-label={t("reply.quote_jump", { nick: parent().author })}
            onClick={() => props.onJump(parent().message_id)}
            type="button"
          >
            <QuotedLine parent={parent()} />
          </button>
        )}
      </Match>
      <Match when={parentIn(props.parent, ["fetched"])}>
        {(parent) => (
          <span
            {...quoteAttributes()}
            aria-label={t("reply.quote_fetched", { nick: parent().author })}
            role="note"
          >
            <QuotedLine parent={parent()} />
          </span>
        )}
      </Match>
      <Match
        when={parentIn(props.parent, ["loading", "deleted", "unavailable"])}
      >
        {(parent) => (
          <span {...quoteAttributes()}>
            <ReplyIcon class={styles.icon} />
            <span class={styles.text}>
              {t(missingParentText[parent().state])}
            </span>
          </span>
        )}
      </Match>
    </Switch>
  );
}

function QuotedLine(props: {
  readonly parent: ParentIn<"loaded" | "fetched">;
}) {
  return (
    <>
      <ReplyIcon class={styles.icon} />
      <span
        class={styles.nick}
        style={{ color: nickColor(props.parent.nick_color_index) }}
      >
        {props.parent.author}
      </span>
      <span class={styles.text}>{props.parent.text}</span>
    </>
  );
}

function parentIn<State extends ReplyParent["state"]>(
  parent: ReplyParent,
  states: readonly State[],
): ParentIn<State> | undefined {
  return (states as readonly string[]).includes(parent.state)
    ? (parent as ParentIn<State>)
    : undefined;
}
