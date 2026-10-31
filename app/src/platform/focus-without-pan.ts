import {
  keyboardGeometryMeasuredEvent,
  requestCachedKeyboardOpen,
} from "./viewport-geometry";

export function focusWithoutViewportPan(
  field: HTMLElement,
  browserWindow: Window = window,
): void {
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
  requestCachedKeyboardOpen(browserWindow);
  try {
    field.focus({ preventScroll: true });
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

const tapSlop = 10;
const longPressMilliseconds = 500;

export class TouchTapGesture {
  #start: TouchStart | undefined;
  #moved = false;

  begin(touch: TouchPoint, time: number): void {
    this.#start = { ...touch, time };
    this.#moved = false;
  }

  move(touch: TouchPoint): void {
    const start = this.#start;
    if (start === undefined || touch.identifier !== start.identifier) {
      this.cancel();
      return;
    }
    this.#moved ||= distance(start, touch) > tapSlop;
  }

  end(touch: TouchPoint, time: number): boolean {
    const start = this.#start;
    const moved =
      this.#moved || (start !== undefined && distance(start, touch) > tapSlop);
    this.cancel();
    return (
      start !== undefined &&
      touch.identifier === start.identifier &&
      !moved &&
      time - start.time >= 0 &&
      time - start.time < longPressMilliseconds
    );
  }

  cancel(): void {
    this.#start = undefined;
    this.#moved = false;
  }
}

function distance(start: TouchPoint, current: TouchPoint): number {
  return Math.hypot(
    current.clientX - start.clientX,
    current.clientY - start.clientY,
  );
}
