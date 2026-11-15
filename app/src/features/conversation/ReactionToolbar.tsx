import { For, Show } from "solid-js";
import { t } from "../../strings";
import { AddReactionIcon } from "../../ui/icons/AddReactionIcon";
import { desktopQuickReactions } from "./quick-reactions";
import styles from "./ReactionToolbar.module.css";

export function ReactionToolbar(props: {
  readonly mine: ReadonlySet<string>;
  readonly onReact: (reaction: string) => void;
  readonly onOpenPicker?: ((invoker: HTMLElement) => void) | undefined;
}) {
  return (
    <div
      aria-label={t("reaction.toolbar")}
      class={styles.toolbar}
      data-reaction-toolbar="true"
      role="toolbar"
    >
      <For each={desktopQuickReactions}>
        {(reaction) => (
          <button
            aria-label={t("reaction.react_with", { reaction })}
            aria-pressed={props.mine.has(reaction)}
            class={styles.button}
            data-focus-key={`toolbar:${reaction}`}
            onClick={() => props.onReact(reaction)}
            type="button"
          >
            {reaction}
          </button>
        )}
      </For>
      <Show when={props.onOpenPicker}>
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
    </div>
  );
}
