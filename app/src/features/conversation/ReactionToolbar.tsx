import { For, Show } from "solid-js";
import { t } from "../../strings";
import { AddReactionIcon } from "../../ui/icons/AddReactionIcon";
import { MoreIcon } from "../../ui/icons/MoreIcon";
import { ReplyIcon } from "../../ui/icons/ReplyIcon";
import { desktopQuickReactions } from "./quick-reactions";
import styles from "./ReactionToolbar.module.css";

export function ReactionToolbar(props: {
  readonly mine: ReadonlySet<string>;
  readonly onReact?: ((reaction: string) => void) | undefined;
  readonly onOpenPicker?: ((invoker: HTMLElement) => void) | undefined;
  readonly onReply?: (() => void) | undefined;
  readonly onOpenMore?: ((invoker: HTMLElement) => void) | undefined;
}) {
  return (
    <div
      aria-label={t("reaction.toolbar")}
      class={styles.toolbar}
      data-reaction-toolbar="true"
      role="toolbar"
    >
      <Show when={props.onReact}>
        {(onReact) => (
          <For each={desktopQuickReactions}>
            {(reaction) => (
              <button
                aria-label={t("reaction.react_with", { reaction })}
                aria-pressed={props.mine.has(reaction)}
                class={styles.button}
                data-focus-key={`toolbar:${reaction}`}
                onClick={() => onReact()(reaction)}
                type="button"
              >
                {reaction}
              </button>
            )}
          </For>
        )}
      </Show>
      <Show when={props.onReact !== undefined && props.onOpenPicker}>
        {(openPicker) => (
          <>
            <span aria-hidden="true" class={styles.separator} />
            <button
              aria-haspopup="dialog"
              aria-label={t("reaction.add")}
              class={styles.button}
              data-add-reaction="true"
              data-focus-key="toolbar:add"
              onClick={(event) => openPicker()(event.currentTarget)}
              type="button"
            >
              <AddReactionIcon class={styles.icon} />
            </button>
          </>
        )}
      </Show>
      <Show when={props.onReply}>
        {(reply) => (
          <button
            aria-label={t("reply.action")}
            class={styles.button}
            data-focus-key="toolbar:reply"
            onClick={() => reply()()}
            type="button"
          >
            <ReplyIcon class={styles.icon} />
          </button>
        )}
      </Show>
      <Show when={props.onOpenMore}>
        {(openMore) => (
          <button
            aria-haspopup="menu"
            aria-label={t("message.more_actions")}
            class={styles.button}
            data-focus-key="toolbar:more"
            data-message-more="true"
            onClick={(event) => openMore()(event.currentTarget)}
            type="button"
          >
            <MoreIcon class={styles.icon} />
          </button>
        )}
      </Show>
    </div>
  );
}
