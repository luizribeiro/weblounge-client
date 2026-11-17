import { type JSX, onMount } from "solid-js";
import styles from "./AlertDialog.module.css";

interface AlertDialogFrameProps {
  readonly label: string;
  readonly message: string;
  readonly explanation: string;
  /** The dialog's controls in Tab order; the first one takes focus on open. */
  readonly focusables: () => readonly (HTMLElement | undefined)[];
  readonly onDismiss: () => void;
  readonly children: JSX.Element;
}

/** The modal alert shell: scrim, title, explanation, Escape and a Tab cycle over its controls. */
export function AlertDialogFrame(props: AlertDialogFrameProps) {
  const controls = () =>
    props
      .focusables()
      .filter((element): element is HTMLElement => element !== undefined);
  const cycleFocus = (from: EventTarget | null, backwards: boolean) => {
    const elements = controls();
    const index = elements.findIndex((element) => element === from);
    const step = backwards ? elements.length - 1 : 1;
    const next =
      index < 0 ? (backwards ? elements.length - 1 : 0) : index + step;
    elements[next % elements.length]?.focus();
  };
  onMount(() => controls()[0]?.focus({ preventScroll: true }));
  return (
    <div class={styles.backdrop}>
      <div
        aria-label={props.label}
        aria-modal="true"
        class={styles.dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onDismiss();
          } else if (event.key === "Tab") {
            event.preventDefault();
            cycleFocus(event.target, event.shiftKey);
          }
        }}
        role="alertdialog"
      >
        <h2>{props.message}</h2>
        <p>{props.explanation}</p>
        {props.children}
      </div>
    </div>
  );
}
