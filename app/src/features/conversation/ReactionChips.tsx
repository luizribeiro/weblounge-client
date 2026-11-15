import { type Accessor, createSignal, Index, Show } from "solid-js";
import type { ReactionProjection } from "../../engine/generated/ReactionProjection";
import { t } from "../../strings";
import styles from "./ReactionChips.module.css";

export function ReactionChips(props: {
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly reactions: readonly ReactionProjection[] | undefined;
  readonly onToggle?: ((reaction: string) => void) | undefined;
}) {
  const [active, setActive] = createSignal<string>();

  return (
    <Show when={(props.reactions?.length ?? 0) > 0}>
      <div
        class={styles.chips}
        data-presentation={props.presentation}
        data-reaction-chips="true"
      >
        {/* Index keeps a toggled chip's button, and so its keyboard focus, across projection updates. */}
        <Index each={props.reactions}>
          {(reaction) => (
            <span class={styles.wrapper}>
              <Show
                when={props.onToggle}
                fallback={
                  <span
                    {...chipAttributes(reaction, setActive)}
                    aria-label={reactionLabel(reaction())}
                    role="img"
                  >
                    <ChipContent reaction={reaction()} />
                  </span>
                }
              >
                {(toggle) => (
                  <button
                    {...chipAttributes(reaction, setActive)}
                    aria-label={toggleLabel(reaction())}
                    aria-pressed={reaction().mine}
                    onBlur={() => setActive(undefined)}
                    onClick={() => toggle()(reaction().text)}
                    onFocus={() => setActive(reaction().text)}
                    type="button"
                  >
                    <ChipContent reaction={reaction()} />
                  </button>
                )}
              </Show>
              <Show when={active() === reaction().text}>
                <span class={styles.tooltip} role="tooltip">
                  <Show
                    when={reaction().own_delivery !== "failed"}
                    fallback={t("reaction.failed_tooltip")}
                  >
                    <strong class={styles.tooltipWho}>
                      {reactionWho(reaction())}
                    </strong>{" "}
                    {t("reaction.who_action", { reaction: reaction().text })}
                  </Show>
                </span>
              </Show>
            </span>
          )}
        </Index>
      </div>
    </Show>
  );
}

function chipAttributes(
  reaction: Accessor<ReactionProjection>,
  setActive: (text: string | undefined) => void,
) {
  return {
    get class() {
      return `${styles.chip} ${reaction().mine ? styles.own : ""}`;
    },
    get "data-reaction"() {
      return reaction().text;
    },
    get "data-reaction-own"() {
      return reaction().mine ? "true" : undefined;
    },
    get "data-reaction-delivery"() {
      return reaction().own_delivery;
    },
    onMouseEnter: () => setActive(reaction().text),
    onMouseLeave: () => setActive(undefined),
  };
}

function ChipContent(props: { readonly reaction: ReactionProjection }) {
  return (
    <>
      <span class={isEmojiReaction(props.reaction.text) ? "" : styles.text}>
        {displayReaction(props.reaction.text)}
      </span>
      <span class={styles.count}>
        {props.reaction.own_delivery === "failed"
          ? "!"
          : props.reaction.actors.length}
      </span>
    </>
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

function toggleLabel(reaction: ReactionProjection): string {
  if (reaction.own_delivery === "failed")
    return t("reaction.failed_label", { reaction: reaction.text });
  const sending =
    reaction.own_delivery === "sending" ? t("reaction.sending") : "";
  return `${reactionLabel(reaction)}${sending}`;
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
