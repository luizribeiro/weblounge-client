import { For, Show } from "solid-js";
import type { TypingProjection } from "../../engine/protocol";
import { t } from "../../strings";
import { nickColor } from "../conversation/nick-color";
import styles from "../conversation/SimpleComposer.module.css";

interface TypingIndicatorProps {
  readonly typers: readonly TypingProjection[];
}

export function TypingIndicator(props: TypingIndicatorProps) {
  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      class={styles.typing}
      data-typing-indicator="true"
    >
      <span class={styles.typingText} data-typing-text="true">
        <Show when={props.typers.length < 3} fallback={t("typing.several")}>
          <For each={props.typers}>
            {(typer, index) => (
              <>
                {index() === 1 ? ` ${t("typing.and")} ` : ""}
                <span
                  data-typing-nick={typer.nick}
                  style={{ color: nickColor(typer.nick_color_index) }}
                >
                  {typer.nick}
                </span>
              </>
            )}
          </For>
          {props.typers.length === 1
            ? ` ${t("typing.is_typing")}`
            : props.typers.length === 2
              ? ` ${t("typing.are_typing")}`
              : ""}
        </Show>
      </span>
    </p>
  );
}
