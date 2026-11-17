import { For } from "solid-js";
import styles from "./ChordHint.module.css";
import { chordKeys, isMacModifier } from "./chord-keys";

export function ChordHint(props: { readonly label: string }) {
  return (
    <kbd class={styles.chord} data-chord>
      <span class="visually-hidden">{props.label}</span>
      <span aria-hidden="true" class={styles.caps}>
        <For each={chordKeys(props.label)}>
          {(key) => (
            <kbd
              class={styles.key}
              data-key
              data-glyph={key.length === 1}
              data-modifier={isMacModifier(key)}
            >
              {key}
            </kbd>
          )}
        </For>
      </span>
    </kbd>
  );
}
