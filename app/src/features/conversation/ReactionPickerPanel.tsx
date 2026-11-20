import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../strings";
import { pickerGroups } from "./emoji-catalog";
import { type EmojiIndex, loadEmojiIndex } from "./emoji-search";
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
  const [index, setIndex] = createSignal<EmojiIndex>();
  const [loadFailed, setLoadFailed] = createSignal(false);
  const load = () => {
    setLoadFailed(false);
    loadEmojiIndex().then(setIndex, () => setLoadFailed(true));
  };
  load();
  const groups = createMemo(() => pickerGroups(index(), query()));
  const searching = () => query().trim() !== "";
  return (
    <div class={styles.panel} data-presentation={props.presentation}>
      <label class={styles.label}>
        {t("reaction.picker_title", { nick: props.nick })}
        <input
          class={styles.search}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            if (loadFailed()) load();
          }}
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
        <Show when={searching() && loadFailed()}>
          <p class={styles.empty}>{t("reaction.search_unavailable")}</p>
        </Show>
        <Show
          when={searching() && index() !== undefined && groups().length === 0}
        >
          <p class={styles.empty}>
            {t("reaction.no_match", { query: query().trim() })}
          </p>
        </Show>
      </div>
    </div>
  );
}
