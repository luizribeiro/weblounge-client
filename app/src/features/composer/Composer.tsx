import { createEffect, createSignal, type JSX } from "solid-js";
import styles from "../conversation/SimpleComposer.module.css";

interface ComposerProps {
  readonly bufferId: number;
  readonly bufferTitle: string;
  readonly candidates?: readonly string[];
  readonly disabled?: boolean;
  readonly onSelectLast?: () => void;
  readonly onSend: (text: string) => void;
}

const draftKey = (id: number) => `weblounge:draft:${id}`;

export function Composer(props: ComposerProps) {
  let textarea: HTMLTextAreaElement | undefined;
  let completion:
    | { start: number; end: number; candidates: readonly string[] }
    | undefined;
  let currentBuffer = props.bufferId;
  const [text, setText] = createSignal(
    sessionStorage.getItem(draftKey(currentBuffer)) ?? "",
  );
  const [selected, setSelected] = createSignal(-1);

  createEffect(() => {
    if (props.bufferId === currentBuffer) return;
    currentBuffer = props.bufferId;
    setText(sessionStorage.getItem(draftKey(currentBuffer)) ?? "");
    setSelected(-1);
  });

  const update = (value: string, resetCompletion = true) => {
    setText(value);
    sessionStorage.setItem(draftKey(currentBuffer), value);
    if (resetCompletion) {
      completion = undefined;
      setSelected(-1);
    }
  };
  const submit = () => {
    if (text().trim() === "") return;
    props.onSend(text());
    sessionStorage.removeItem(draftKey(currentBuffer));
    setText("");
    setSelected(-1);
  };
  const complete = (offset: number) => {
    if (completion === undefined) {
      const end = textarea?.selectionStart ?? text().length;
      const start = text().slice(0, end).search(/\S*$/);
      const token = text().slice(start, end).toLocaleLowerCase();
      completion = {
        start,
        end,
        candidates: (props.candidates ?? []).filter((candidate) =>
          candidate.toLocaleLowerCase().startsWith(token),
        ),
      };
    }
    if (completion.candidates.length === 0) return false;
    const next =
      (selected() + offset + completion.candidates.length) %
      completion.candidates.length;
    setSelected(next);
    const candidate = completion.candidates[next] ?? "";
    update(
      `${text().slice(0, completion.start)}${candidate} ${text().slice(completion.end)}`,
      false,
    );
    completion.end = completion.start + candidate.length + 1;
    queueMicrotask(() =>
      textarea?.setSelectionRange(completion?.end ?? 0, completion?.end ?? 0),
    );
    return true;
  };
  const keydown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (
    event,
  ) => {
    if (event.isComposing || event.keyCode === 229 || event.key === "Process")
      return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "Tab" && complete(event.shiftKey ? -1 : 1)) {
      event.preventDefault();
    } else if (event.key === "ArrowUp" && text() === "") {
      props.onSelectLast?.();
    }
  };

  return (
    <div class={styles.wrap}>
      {selected() >= 0 && (
        <div class={styles.candidates}>{props.candidates?.join("  ")}</div>
      )}
      <div class={styles.form}>
        <textarea
          aria-label={`Message ${props.bufferTitle}`}
          autocomplete="off"
          class={styles.input}
          disabled={props.disabled}
          onCompositionStart={() => setSelected(-1)}
          onInput={(event) => update(event.currentTarget.value)}
          onKeyDown={keydown}
          placeholder={`Message ${props.bufferTitle}`}
          ref={textarea}
          rows={1}
          value={text()}
        />
        <button
          class={styles.send}
          disabled={props.disabled}
          onClick={submit}
          type="button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
