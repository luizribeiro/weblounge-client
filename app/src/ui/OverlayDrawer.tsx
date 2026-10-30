import {
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
} from "solid-js";
import styles from "./OverlayDrawer.module.css";

interface OverlayDrawerProps {
  readonly children:
    | JSX.Element
    | ((requestClose: () => void, settledOpen: () => boolean) => JSX.Element);
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

type DrawerPhase = "entering" | "opening" | "open" | "closing";

export function OverlayDrawer(props: OverlayDrawerProps) {
  let drawer: HTMLDivElement | undefined;
  const [phase, setPhase] = createSignal<DrawerPhase>(
    props.dragProgress === undefined ? "entering" : "open",
  );
  const settle = () => {
    if (phase() === "closing") {
      props.onClose();
      return;
    }
    if (phase() === "opening") setPhase("open");
    if (props.dragReturning === true) props.onDragReturnEnd?.();
  };
  const settleUnlessMoving = () => {
    if (!movingTransform(drawer)) settle();
  };
  const moveTo = (next: "opening" | "closing") => {
    setPhase(next);
    queueMicrotask(settleUnlessMoving);
  };
  const requestClose = () => {
    if (phase() !== "closing") moveTo("closing");
  };
  const following = () =>
    props.dragProgress !== undefined && phase() === "open";

  const settledOpen = () => phase() === "open";

  onMount(() => {
    if (phase() !== "entering") return;
    onCleanup(
      afterStartStatePaints(() => {
        if (phase() === "entering") moveTo("opening");
      }),
    );
  });

  createEffect(() => {
    if (props.dragReturning === true) queueMicrotask(settleUnlessMoving);
  });

  createEffect(() => {
    if (props.closing === true) requestClose();
  });

  createEffect(() => {
    if (props.dragProgress !== undefined) return;
    queueMicrotask(() => initialFocus(drawer)?.focus({ preventScroll: true }));
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

  const transformEvent = (event: TransitionEvent) =>
    event.target === drawer && event.propertyName === "transform";

  return (
    <div
      class={styles.overlay}
      data-drag-returning={props.dragReturning}
      data-dragging={
        following() && props.dragReturning !== true ? "true" : undefined
      }
      data-moving={phase() !== "open" || following() ? "true" : undefined}
      data-overlay-drawer={props.edge}
      data-phase={phase()}
      style={{
        "--wl-overlay-drawer-offset": following()
          ? props.dragProgress
          : undefined,
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
        onKeyDown={keydown}
        onTransitionCancel={(event) => {
          if (transformEvent(event)) queueMicrotask(settleUnlessMoving);
        }}
        onTransitionEnd={(event) => {
          if (transformEvent(event)) settleUnlessMoving();
        }}
        ref={drawer}
        role="dialog"
      >
        {typeof props.children === "function"
          ? props.children(requestClose, settledOpen)
          : props.children}
      </div>
    </div>
  );
}

function afterStartStatePaints(callback: () => void): () => void {
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(callback);
  });
  return () => cancelAnimationFrame(frame);
}

function movingTransform(element: HTMLElement | undefined): boolean {
  if (element === undefined || typeof element.getAnimations !== "function")
    return false;
  return element
    .getAnimations()
    .some(
      (animation) =>
        animation.playState === "running" &&
        (animation as CSSTransition).transitionProperty === "transform",
    );
}

function initialFocus(root: HTMLElement | undefined): HTMLElement | undefined {
  return (
    root?.querySelector<HTMLElement>("[data-initial-focus]") ??
    focusable(root)[0]
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
