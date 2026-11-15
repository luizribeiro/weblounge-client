import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../strings";
import { searchEmoji } from "./emoji-catalog";
import styles from "./ReactionPicker.module.css";

/** The searchable emoji categories, shared by the desktop popover and the phone sheet. */
export function ReactionPickerPanel(props: {
  readonly nick: string;
  readonly mine: ReadonlySet<string>;
  readonly onPick: (reaction: string) => void;
  readonly presentation?: "desktop" | "mobile" | undefined;
  readonly searchRef?: ((search: HTMLInputElement) => void) | undefined;
}) {
  const [query, setQuery] = createSignal("");
  const groups = createMemo(() => searchEmoji(query()));
  return (
    <div class={styles.panel} data-presentation={props.presentation}>
      <label class={styles.label}>
        {t("reaction.picker_title", { nick: props.nick })}
        <input
          class={styles.search}
          onInput={(event) => setQuery(event.currentTarget.value)}
          placeholder={t("reaction.search")}
          ref={(search) => props.searchRef?.(search)}
          type="search"
          value={query()}
        />
      </label>
      <div class={styles.groups} data-reaction-picker-groups="true">
        <For each={groups()}>
          {(group) => (
            <section aria-label={group.name} class={styles.group}>
              <h3 class={styles.groupName}>{group.name}</h3>
              <div class={styles.grid}>
                <For each={group.entries}>
                  {(entry) => (
                    <button
                      aria-label={entry.name}
                      aria-pressed={props.mine.has(entry.emoji)}
                      class={styles.emoji}
                      onClick={() => props.onPick(entry.emoji)}
                      title={entry.name}
                      type="button"
                    >
                      {entry.emoji}
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
        <Show when={groups().length === 0}>
          <p class={styles.empty}>
            {t("reaction.no_match", { query: query().trim() })}
          </p>
        </Show>
      </div>
    </div>
  );
}
