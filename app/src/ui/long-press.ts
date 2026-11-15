import { type Accessor, createSignal, onCleanup } from "solid-js";

export const longPressMilliseconds = 500;
const movementSlopPixels = 10;

interface Press {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly timer: number;
}

export interface LongPress {
  /** True from touch-down until the press fires or is abandoned, for press feedback. */
  readonly pressing: Accessor<boolean>;
  readonly attach: (element: HTMLElement) => void;
}

/**
 * Recognises a held touch that neither moves nor lifts, and a context-menu request from a mouse
 * or the platform's own long-press, as one intent. Moving past the slop, lifting, or the browser
 * cancelling the pointer to scroll abandons the press; the click that follows a recognised press
 * is swallowed so a link or chip under the finger does not activate as well.
 */
export function createLongPress(onLongPress: () => void): LongPress {
  const [pressing, setPressing] = createSignal(false);
  let press: Press | undefined;
  let recognised = false;
  let swallowClick = false;

  const abandon = () => {
    if (press !== undefined) window.clearTimeout(press.timer);
    press = undefined;
    setPressing(false);
  };
  const recognise = () => {
    abandon();
    recognised = true;
    swallowClick = true;
    onLongPress();
  };

  const onPointerDown = (event: PointerEvent) => {
    abandon();
    recognised = false;
    swallowClick = false;
    if (!event.isPrimary || event.pointerType === "mouse" || hasSelection())
      return;
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      // wait-ok: this is the product's fixed long-press recognition window.
      timer: window.setTimeout(recognise, longPressMilliseconds),
    };
    setPressing(true);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (press === undefined || event.pointerId !== press.pointerId) return;
    const distance = Math.hypot(
      event.clientX - press.x,
      event.clientY - press.y,
    );
    if (distance > movementSlopPixels) abandon();
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    if (!recognised) recognise();
  };
  const onClick = (event: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onVisibility = () => {
    if (document.visibilityState === "hidden") abandon();
  };

  return {
    pressing,
    attach(element) {
      element.addEventListener("pointerdown", onPointerDown);
      element.addEventListener("pointermove", onPointerMove);
      element.addEventListener("pointerup", abandon);
      element.addEventListener("pointercancel", abandon);
      element.addEventListener("contextmenu", onContextMenu);
      element.addEventListener("click", onClick, { capture: true });
      document.addEventListener("visibilitychange", onVisibility);
      onCleanup(() => {
        abandon();
        element.removeEventListener("pointerdown", onPointerDown);
        element.removeEventListener("pointermove", onPointerMove);
        element.removeEventListener("pointerup", abandon);
        element.removeEventListener("pointercancel", abandon);
        element.removeEventListener("contextmenu", onContextMenu);
        element.removeEventListener("click", onClick, { capture: true });
        document.removeEventListener("visibilitychange", onVisibility);
      });
    },
  };
}

/** A press over an existing text selection belongs to the platform's selection handles. */
function hasSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed;
}
