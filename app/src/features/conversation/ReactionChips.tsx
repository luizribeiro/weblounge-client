import { createSignal, For, Show } from "solid-js";
import type { ReactionProjection } from "../../engine/generated/ReactionProjection";
import { t } from "../../strings";
import styles from "./ReactionChips.module.css";

export function ReactionChips(props: {
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly reactions: readonly ReactionProjection[] | undefined;
}) {
  const [active, setActive] = createSignal<string>();

  return (
    <Show when={(props.reactions?.length ?? 0) > 0}>
      <div
        class={styles.chips}
        data-presentation={props.presentation}
        data-reaction-chips="true"
      >
        <For each={props.reactions}>
          {(reaction) => {
            const label = reactionLabel(reaction);
            const who = reactionWho(reaction);
            const text = displayReaction(reaction.text);
            return (
              <span class={styles.wrapper}>
                <span
                  aria-label={label}
                  class={`${styles.chip} ${reaction.mine ? styles.own : ""}`}
                  data-reaction={reaction.text}
                  data-reaction-own={reaction.mine ? "true" : undefined}
                  onMouseEnter={() => setActive(reaction.text)}
                  onMouseLeave={() => setActive(undefined)}
                  role="img"
                >
                  <span
                    class={isEmojiReaction(reaction.text) ? "" : styles.text}
                  >
                    {text}
                  </span>
                  <span class={styles.count}>{reaction.actors.length}</span>
                </span>
                <Show when={active() === reaction.text}>
                  <span class={styles.tooltip} role="tooltip">
                    <strong class={styles.tooltipWho}>{who}</strong>{" "}
                    {t("reaction.who_action", { reaction: reaction.text })}
                  </span>
                </Show>
              </span>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

function displayReaction(value: string): string {
  const characters = Array.from(value);
  return characters.length > 16
    ? `${characters.slice(0, 16).join("")}…`
    : value;
}

function isEmojiReaction(value: string): boolean {
  return (
    value.length > 0 &&
    value.replace(
      /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3)/gu,
      "",
    ) === ""
  );
}

function reactionLabel(reaction: ReactionProjection): string {
  const ownership = reaction.mine ? t("reaction.including_you") : "";
  const key =
    reaction.actors.length === 1 ? "reaction.label_one" : "reaction.label_many";
  return t(key, {
    reaction: reaction.text,
    count: String(reaction.actors.length),
    ownership,
  });
}

function reactionWho(reaction: ReactionProjection): string {
  const names = reaction.actors.map((actor) =>
    actor.mine ? t("reaction.you") : actor.nick,
  );
  return formatNames(names);
}

function formatNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  const final = names.at(-1) ?? "";
  const leading = names.slice(0, -1).join(", ");
  return `${leading} ${t("typing.and")} ${final}`;
}
