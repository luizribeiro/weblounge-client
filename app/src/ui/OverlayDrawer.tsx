import { createEffect, createSignal, type JSX } from "solid-js";
import styles from "./OverlayDrawer.module.css";

interface OverlayDrawerProps {
  readonly children: JSX.Element | ((requestClose: () => void) => JSX.Element);
  readonly closeLabel: string;
  readonly closing?: boolean | undefined;
  readonly edge: "left" | "right";
  readonly label: string;
  readonly onClose: () => void;
  readonly dragProgress?: number | undefined;
  readonly dragReturning?: boolean | undefined;
  readonly onDragReturnEnd?: (() => void) | undefined;
  readonly width: string;
}

export function OverlayDrawer(props: OverlayDrawerProps) {
  let drawer: HTMLDivElement | undefined;
  const [phase, setPhase] = createSignal<"opening" | "open" | "closing">(
    props.dragProgress === undefined ? "opening" : "open",
  );
  const requestClose = () => setPhase("closing");

  createEffect(() => {
    if (props.closing === true) requestClose();
  });

  createEffect(() => {
    if (props.dragProgress !== undefined) return;
    queueMicrotask(() => focusable(drawer)[0]?.focus());
  });

  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
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
    <div
      class={styles.overlay}
      data-drag-returning={props.dragReturning}
      data-dragging={props.dragProgress === undefined ? undefined : "true"}
      data-overlay-drawer={props.edge}
      data-phase={phase()}
      style={{
        "--wl-overlay-drawer-progress": props.dragProgress,
        "--wl-overlay-drawer-width": props.width,
      }}
    >
      <button
        aria-label={props.closeLabel}
        class={styles.backdrop}
        data-overlay-scrim="true"
        onClick={requestClose}
        type="button"
      />
      <div
        aria-label={props.label}
        aria-modal="true"
        class={styles.drawer}
        data-edge={props.edge}
        onAnimationEnd={(event) => {
          if (event.target !== drawer) return;
          if (
            phase() === "closing" &&
            event.animationName.includes("drawer-out-")
          )
            props.onClose();
          else if (
            phase() === "opening" &&
            event.animationName.includes("drawer-in-")
          )
            setPhase("open");
        }}
        onKeyDown={keydown}
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform") props.onDragReturnEnd?.();
        }}
        ref={drawer}
        role="dialog"
      >
        {typeof props.children === "function"
          ? props.children(requestClose)
          : props.children}
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
