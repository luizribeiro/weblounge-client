import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { t } from "../../strings";
import { trapTab } from "../../ui/focus-trap";
import { searchEmoji } from "./emoji-catalog";
import { pickerPosition } from "./picker-position";
import styles from "./ReactionPicker.module.css";

export function ReactionPicker(props: {
  readonly invoker: HTMLElement;
  readonly nick: string;
  readonly mine: ReadonlySet<string>;
  readonly onPick: (reaction: string) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const groups = createMemo(() => searchEmoji(query()));
  let dialog: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;

  const close = () => {
    props.invoker.focus({ preventScroll: true });
    props.onClose();
  };
  const pick = (reaction: string) => {
    props.invoker.focus({ preventScroll: true });
    if (!props.mine.has(reaction)) props.onPick(reaction);
    props.onClose();
  };

  onMount(() => {
    if (dialog !== undefined) place(dialog, props.invoker);
    search?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (dialog?.contains(target) !== true && !props.invoker.contains(target))
        props.onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    onCleanup(() => document.removeEventListener("pointerdown", dismiss));
  });

  return (
    <Portal>
      <div
        aria-label={t("reaction.add")}
        aria-modal="true"
        class={styles.picker}
        data-reaction-picker="true"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else trapTab(event, dialog);
        }}
        ref={dialog}
        role="dialog"
      >
        <label class={styles.label}>
          {t("reaction.picker_title", { nick: props.nick })}
          <input
            class={styles.search}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("reaction.search")}
            ref={search}
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
                        onClick={() => pick(entry.emoji)}
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
    </Portal>
  );
}

function place(dialog: HTMLElement, invoker: HTMLElement): void {
  const position = pickerPosition(
    invoker.getBoundingClientRect(),
    dialog.getBoundingClientRect(),
    window,
  );
  dialog.style.setProperty("--wl-reaction-picker-left", `${position.left}px`);
  dialog.style.setProperty("--wl-reaction-picker-top", `${position.top}px`);
}
