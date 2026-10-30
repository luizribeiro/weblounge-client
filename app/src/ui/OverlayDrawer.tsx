import { type JSX, onMount } from "solid-js";
import styles from "./OverlayDrawer.module.css";

interface OverlayDrawerProps {
  readonly children: JSX.Element;
  readonly closeLabel: string;
  readonly edge: "left" | "right";
  readonly label: string;
  readonly onClose: () => void;
  readonly width: string;
}

export function OverlayDrawer(props: OverlayDrawerProps) {
  let drawer: HTMLDivElement | undefined;

  onMount(() => {
    queueMicrotask(() => focusable(drawer)[0]?.focus());
  });

  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focusable(drawer);
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
  };

  return (
    <div class={styles.overlay} data-overlay-drawer={props.edge}>
      <button
        aria-label={props.closeLabel}
        class={styles.backdrop}
        onClick={props.onClose}
        type="button"
      />
      <div
        aria-label={props.label}
        aria-modal="true"
        class={styles.drawer}
        data-edge={props.edge}
        onKeyDown={keydown}
        ref={drawer}
        role="dialog"
        style={{ "--wl-overlay-drawer-width": props.width }}
      >
        {props.children}
      </div>
    </div>
  );
}

function focusable(root: HTMLElement | undefined): HTMLElement[] {
  if (root === undefined) return [];
  return [
    ...root.querySelectorAll<HTMLElement>("button, input, [tabindex]"),
  ].filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex >= 0,
  );
}
