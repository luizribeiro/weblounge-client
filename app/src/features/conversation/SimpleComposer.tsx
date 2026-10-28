import type { JSX } from "solid-js";
import styles from "./SimpleComposer.module.css";

interface SimpleComposerProps {
  readonly bufferTitle: string;
  readonly disabled?: boolean;
  readonly onSend: (text: string) => void;
}

export function SimpleComposer(props: SimpleComposerProps) {
  const submit: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("message");
    if (!(input instanceof HTMLInputElement)) return;
    const text = input.value.trim();
    if (text === "") return;
    props.onSend(text);
    event.currentTarget.reset();
  };

  return (
    <form class={styles.form} onSubmit={submit}>
      <input
        aria-label={`Message ${props.bufferTitle}`}
        autocomplete="off"
        class={styles.input}
        disabled={props.disabled}
        name="message"
        placeholder={`Message ${props.bufferTitle}`}
      />
      <button class={styles.send} disabled={props.disabled} type="submit">
        Send
      </button>
    </form>
  );
}
