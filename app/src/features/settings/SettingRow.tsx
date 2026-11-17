import { createUniqueId, type JSX, Show } from "solid-js";
import styles from "./SettingRow.module.css";

export interface SettingControlIds {
  readonly labelledBy: string;
  readonly describedBy: string;
}

/** A status line under the description, such as why the control can't be used. */
export interface SettingNote {
  readonly text: string;
  readonly tone: "neutral" | "error";
  readonly action?:
    | { readonly label: string; readonly run: () => void }
    | undefined;
}

interface SettingRowProps {
  readonly label: string;
  readonly description: string;
  readonly control: "choice" | "switch";
  readonly note?: SettingNote | undefined;
  readonly children: (ids: SettingControlIds) => JSX.Element;
}

export function SettingRow(props: SettingRowProps) {
  const labelledBy = createUniqueId();
  const descriptionId = createUniqueId();
  const noteId = createUniqueId();
  const ids: SettingControlIds = {
    labelledBy,
    get describedBy() {
      return props.note === undefined
        ? descriptionId
        : `${descriptionId} ${noteId}`;
    },
  };
  return (
    <div class={styles.row} data-control={props.control}>
      <div class={styles.text}>
        <span class={styles.label} id={labelledBy}>
          {props.label}
        </span>
        <span class={styles.description} id={descriptionId}>
          {props.description}
        </span>
        <span class={styles.note} role="status">
          <Show when={props.note} keyed>
            {(note) => (
              <>
                <span data-tone={note.tone} id={noteId}>
                  {note.text}
                </span>
                <Show when={note.action} keyed>
                  {(action) => (
                    <button
                      class={styles.noteAction}
                      onClick={() => action.run()}
                      type="button"
                    >
                      {action.label}
                    </button>
                  )}
                </Show>
              </>
            )}
          </Show>
        </span>
      </div>
      {props.children(ids)}
    </div>
  );
}
