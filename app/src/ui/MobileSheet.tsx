import { type JSX, onCleanup, onMount } from "solid-js";
import { trapTab } from "./focus-trap";
import styles from "./MobileSheet.module.css";

interface MobileSheetProps {
  readonly children: JSX.Element;
  readonly floating?: JSX.Element | undefined;
  readonly label: string;
  readonly onDismiss: () => void;
}

export function MobileSheet(props: MobileSheetProps) {
  let panel: HTMLDivElement | undefined;
  // A long press opens the sheet under a finger that is still down; the click its lift produces
  // belongs to that press, so it must neither dismiss the sheet nor run the control below it.
  let pressedInside = false;
  const ignoreOpeningClick = (event: MouseEvent) => {
    if (event.detail === 0 || pressedInside) return;
    event.preventDefault();
    event.stopPropagation();
  };
  onMount(() => {
    queueMicrotask(() => {
      const initial =
        panel?.querySelector<HTMLElement>("[data-initial-focus]") ??
        panel?.querySelector<HTMLButtonElement>("button");
      initial?.focus({ preventScroll: true });
    });
    // The sheet is modal, so Escape closes it wherever focus went, before the shell treats it as Back.
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      props.onDismiss();
    };
    document.addEventListener("keydown", dismissOnEscape, { capture: true });
    onCleanup(() =>
      document.removeEventListener("keydown", dismissOnEscape, {
        capture: true,
      }),
    );
  });
  return (
    <div
      class={styles.overlay}
      data-mobile-sheet="true"
      on:click={{ capture: true, handleEvent: ignoreOpeningClick }}
      onPointerDown={() => {
        pressedInside = true;
      }}
    >
      <button
        aria-label={props.label}
        class={styles.backdrop}
        onClick={props.onDismiss}
        type="button"
      />
      {props.floating}
      <div
        aria-label={props.label}
        aria-modal="true"
        class={styles.panel}
        onKeyDown={(event) => trapTab(event, panel)}
        ref={panel}
        role="dialog"
      >
        {props.children}
      </div>
    </div>
  );
}
