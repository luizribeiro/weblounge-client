import { createMemo, For, Show } from "solid-js";
import { t } from "../../../strings";
import { Selectable } from "../../../ui/Selectable";
import styles from "./MotdCard.module.css";
import { type MotdCardEvent, motdFolds, motdShownLines } from "./motd-lines";
import { SystemCard } from "./SystemCard";
import lineStyles from "./SystemLine.module.css";

export function MotdCard(props: {
  readonly card: MotdCardEvent;
  readonly expanded: boolean;
  readonly onToggle: (expanded: boolean) => void;
  readonly presentation: "desktop" | "mobile";
  readonly timeMs: number;
}) {
  const shown = createMemo(() => motdShownLines(props.card, props.expanded));
  return (
    <SystemCard
      accessibleName={[t("messages.motd.title"), ...shown()].join(". ")}
      icon="server"
      kind="motd"
      presentation={props.presentation}
      timeMs={props.timeMs}
      title={t("messages.motd.title")}
    >
      <div class={styles.lines} data-system-card-text="true">
        <Selectable surfaceId="motd-card-text">
          <For each={shown()}>
            {(line) => (
              <span class={styles.line} data-motd-line="true">
                {line}
              </span>
            )}
          </For>
        </Selectable>
      </div>
      <Show when={motdFolds(props.card)}>
        <div class={styles.toggle}>
          <button
            aria-expanded={props.expanded}
            class={lineStyles.action}
            onClick={() => props.onToggle(!props.expanded)}
            type="button"
          >
            {props.expanded
              ? t("messages.motd.show_less")
              : t("messages.motd.show_all", {
                  count: String(props.card.lines.length),
                })}
          </button>
        </div>
      </Show>
    </SystemCard>
  );
}
