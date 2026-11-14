import { type JSX, onCleanup, onMount } from "solid-js";
import { trapTab } from "./focus-trap";
import styles from "./OmnibarOverlay.module.css";

interface OmnibarOverlayProps {
  readonly activeDescendant?: string | undefined;
  readonly children: JSX.Element;
  readonly closeLabel: string;
  readonly escapeHint: string;
  readonly inputLabel: string;
  readonly label: string;
  readonly listboxId: string;
  readonly onDismiss: () => void;
  readonly onInput: (value: string) => void;
  readonly onKeyDown?:
    | ((event: KeyboardEvent & { currentTarget: HTMLInputElement }) => boolean)
    | undefined;
  readonly placeholder: string;
  readonly query: string;
  readonly shouldRestoreFocus?: (() => boolean) | undefined;
}

export function OmnibarOverlay(props: OmnibarOverlayProps) {
  const invoker =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  let dialog: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  let focusFrame: number | undefined;

  onMount(() => {
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined;
      input?.focus({ preventScroll: true });
    });
  });
  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    // Read here: the action that closed the overlay sets this flag after cleanup.
    queueMicrotask(() => {
      if (props.shouldRestoreFocus?.() === false) return;
      if (invoker?.isConnected === true) invoker.focus({ preventScroll: true });
    });
  });

  const keydown = (event: KeyboardEvent) => {
    if (
      event.target === input &&
      props.onKeyDown?.(
        event as KeyboardEvent & { currentTarget: HTMLInputElement },
      ) === true
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onDismiss();
      return;
    }
    trapTab(event, dialog);
  };

  return (
    <div class={styles.overlay} data-omnibar-overlay="true">
      <button
        aria-label={props.closeLabel}
        class={styles.backdrop}
        onClick={props.onDismiss}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-label={props.label}
        aria-modal="true"
        class={styles.dialog}
        data-keyboard-surface="true"
        onKeyDown={keydown}
        ref={dialog}
        role="dialog"
      >
        <div class={styles.search}>
          <svg aria-hidden="true" class={styles.icon} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <label class="visually-hidden" for="omnibar-query">
            {props.inputLabel}
          </label>
          <input
            aria-activedescendant={props.activeDescendant}
            aria-autocomplete="list"
            aria-controls={props.listboxId}
            aria-expanded="true"
            autocomplete="off"
            id="omnibar-query"
            onInput={(event) => props.onInput(event.currentTarget.value)}
            placeholder={props.placeholder}
            ref={input}
            role="combobox"
            spellcheck={false}
            type="text"
            value={props.query}
          />
          <kbd>{props.escapeHint}</kbd>
        </div>
        {props.children}
      </div>
    </div>
  );
}
