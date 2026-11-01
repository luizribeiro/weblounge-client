import { keyboardGeometryMeasuredEvent } from "./viewport-geometry";

export function focusWithoutViewportPan(
  field: HTMLElement,
  browserWindow: Window = window,
): boolean {
  const previousTransform = field.style.transform;
  let restored = false;
  let fallback = 0;
  const restore = () => {
    if (restored) return;
    restored = true;
    browserWindow.clearTimeout(fallback);
    browserWindow.removeEventListener(keyboardGeometryMeasuredEvent, restore);
    field.style.transform = previousTransform;
  };

  // Safari can decide where to pan several frames after honoring preventScroll.
  // Keep the field outside its reveal calculation until measured keyboard
  // geometry arrives, with a bounded fallback for keyboards that do not resize.
  // This follows React Aria's iOS workaround:
  // https://github.com/adobe/react-spectrum/blob/7eae25e124a9d235ff30f12bd86383b894a1ea04/packages/%40react-aria/overlays/src/usePreventScroll.ts#L142-L154
  field.style.transform = "translateY(-2000px)";
  browserWindow.addEventListener(keyboardGeometryMeasuredEvent, restore);
  fallback = browserWindow.setTimeout(restore, 1000);
  try {
    field.focus({ preventScroll: true });
    const focused = browserWindow.document.activeElement === field;
    if (!focused) restore();
    return focused;
  } catch (error: unknown) {
    restore();
    throw error;
  }
}

interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
  readonly identifier: number;
}

interface TouchStart extends TouchPoint {
  readonly time: number;
}

type TouchTapRejection =
  | "clock changed"
  | "no start"
  | "touch changed"
  | `held ${number}ms`
  | `moved ${number}px`;

export type TouchTapResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: TouchTapRejection };

const tapSlop = 10;
const longPressMilliseconds = 500;

export class TouchTapGesture {
  #start: TouchStart | undefined;
  #movement = 0;
  #rejection: TouchTapRejection | undefined;

  begin(touch: TouchPoint, time: number): void {
    this.#start = { ...touch, time };
    this.#movement = 0;
    this.#rejection = undefined;
  }

  move(touch: TouchPoint): void {
    const start = this.#start;
    if (start === undefined) return;
    if (touch.identifier !== start.identifier) {
      this.#rejection = "touch changed";
      return;
    }
    this.#movement = Math.max(this.#movement, distance(start, touch));
    if (outsideTapSlop(start, touch))
      this.#rejection = `moved ${Math.round(this.#movement)}px`;
  }

  end(touch: TouchPoint, time: number): TouchTapResult {
    const start = this.#start;
    if (start === undefined) return { accepted: false, reason: "no start" };
    const duration = time - start.time;
    this.#movement = Math.max(this.#movement, distance(start, touch));
    const rejection =
      this.#rejection ??
      (touch.identifier !== start.identifier
        ? "touch changed"
        : outsideTapSlop(start, touch)
          ? `moved ${Math.round(this.#movement)}px`
          : duration < 0
            ? "clock changed"
            : duration >= longPressMilliseconds
              ? `held ${Math.round(duration)}ms`
              : undefined);
    this.cancel();
    return rejection === undefined
      ? { accepted: true }
      : { accepted: false, reason: rejection };
  }

  cancel(): void {
    this.#start = undefined;
    this.#movement = 0;
    this.#rejection = undefined;
  }
}

function outsideTapSlop(start: TouchPoint, current: TouchPoint): boolean {
  return (
    Math.abs(current.clientX - start.clientX) > tapSlop ||
    Math.abs(current.clientY - start.clientY) > tapSlop
  );
}

function distance(start: TouchPoint, current: TouchPoint): number {
  return Math.hypot(
    current.clientX - start.clientX,
    current.clientY - start.clientY,
  );
}
