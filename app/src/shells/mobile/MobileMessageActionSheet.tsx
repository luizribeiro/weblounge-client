import { createSignal, For, Show } from "solid-js";
import type { MessageProjection } from "../../engine/protocol";
import { nickColor } from "../../features/conversation/nick-color";
import { phoneQuickReactions } from "../../features/conversation/quick-reactions";
import { ReactionPickerPanel } from "../../features/conversation/ReactionPickerPanel";
import { ownReactions } from "../../features/conversation/reaction-target";
import { t } from "../../strings";
import { AddReactionIcon } from "../../ui/icons/AddReactionIcon";
import { MobileSheet } from "../../ui/MobileSheet";
import styles from "./MobileMessageActionSheet.module.css";
import type { MessageSheetAction } from "./message-sheet-actions";

interface MobileMessageActionSheetProps {
  readonly message: MessageProjection;
  readonly actions: readonly MessageSheetAction[];
  /** Absent when the network cannot send reactions or the server has not delivered the message. */
  readonly onReact?: ((reaction: string) => void) | undefined;
  readonly onDismiss: () => void;
}

export function MobileMessageActionSheet(props: MobileMessageActionSheetProps) {
  const [picking, setPicking] = createSignal(false);
  const mine = () => ownReactions(props.message);
  const run = (action: () => void) => {
    action();
    props.onDismiss();
  };
  return (
    <MobileSheet
      label={t("mobile.message_actions", { nick: props.message.author })}
      onDismiss={props.onDismiss}
    >
      <div class={styles.sheet} data-message-sheet="true">
        <p class={styles.preview}>
          <span
            class={styles.nick}
            style={{
              color:
                props.message.authorship === "own"
                  ? "var(--wl-color-self-nick)"
                  : nickColor(props.message.nick_color_index),
            }}
          >
            {props.message.author}
          </span>{" "}
          {props.message.text}
        </p>
        <Show when={props.onReact}>
          {(react) => (
            <div class={styles.quick}>
              <For each={phoneQuickReactions}>
                {(reaction) => (
                  <button
                    aria-label={t("reaction.react_with", { reaction })}
                    aria-pressed={mine().has(reaction)}
                    class={styles.reaction}
                    data-initial-focus={
                      reaction === phoneQuickReactions[0] || undefined
                    }
                    onClick={() => run(() => react()(reaction))}
                    type="button"
                  >
                    {reaction}
                  </button>
                )}
              </For>
              <button
                aria-expanded={picking()}
                aria-label={t("reaction.add")}
                class={styles.reaction}
                data-add-reaction="true"
                onClick={() => setPicking(true)}
                type="button"
              >
                <AddReactionIcon class={styles.addIcon} />
              </button>
            </div>
          )}
        </Show>
        <Show
          when={picking() && props.onReact}
          fallback={
            <div class={styles.actions}>
              <For each={props.actions}>
                {(action) => (
                  <button
                    class={styles.action}
                    data-action={action.id}
                    data-tone={action.tone}
                    onClick={() => run(action.run)}
                    type="button"
                  >
                    <action.icon class={styles.actionIcon} />
                    {action.label}
                  </button>
                )}
              </For>
            </div>
          }
        >
          {(react) => (
            <ReactionPickerPanel
              mine={mine()}
              nick={props.message.author}
              onPick={(reaction) =>
                run(() => {
                  if (!mine().has(reaction)) react()(reaction);
                })
              }
              presentation="mobile"
            />
          )}
        </Show>
      </div>
    </MobileSheet>
  );
}
