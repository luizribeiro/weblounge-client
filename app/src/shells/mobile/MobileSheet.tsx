import { type JSX, onMount } from "solid-js";
import styles from "./MobileSheet.module.css";

interface MobileSheetProps {
  readonly children: JSX.Element;
  readonly floating?: JSX.Element | undefined;
  readonly label: string;
  readonly onDismiss: () => void;
}

export function MobileSheet(props: MobileSheetProps) {
  let panel: HTMLDivElement | undefined;
  onMount(() =>
    queueMicrotask(() => {
      const initial =
        panel?.querySelector<HTMLElement>("[data-initial-focus]") ??
        panel?.querySelector<HTMLButtonElement>("button");
      initial?.focus({ preventScroll: true });
    }),
  );
  const focusable = () => [
    ...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
  return (
    <div class={styles.overlay} data-mobile-sheet="true">
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
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onDismiss();
            return;
          }
          if (event.key !== "Tab") return;
          const elements = focusable();
          const first = elements[0];
          const last = elements.at(-1);
          if (first === undefined || last === undefined) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        ref={panel}
        role="dialog"
      >
        {props.children}
      </div>
    </div>
  );
}
