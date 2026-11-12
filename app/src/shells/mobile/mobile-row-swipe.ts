export const mobileRowActionWidth = 148;
export const mobileRowAxisThreshold = 10;

export type MobileRowSwipeState =
  | { readonly phase: "idle"; readonly revealed: boolean }
  | {
      readonly phase: "tracking" | "dragging";
      readonly kind: "channel" | "direct";
      readonly rowWidth: number;
      readonly startX: number;
      readonly startY: number;
      readonly startOffset: number;
      readonly offset: number;
    }
  | { readonly phase: "cancelled"; readonly revealed: boolean };

export type MobileRowSwipeRelease = "close" | "reveal" | "reset" | "tap";

export function beginMobileRowSwipe(
  kind: "channel" | "direct",
  rowWidth: number,
  x: number,
  y: number,
  revealed: boolean,
): MobileRowSwipeState {
  const startOffset = revealed ? mobileRowActionWidth : 0;
  return {
    phase: "tracking",
    kind,
    rowWidth,
    startX: x,
    startY: y,
    startOffset,
    offset: startOffset,
  };
}

export function moveMobileRowSwipe(
  state: MobileRowSwipeState,
  x: number,
  y: number,
): MobileRowSwipeState {
  if (state.phase !== "tracking" && state.phase !== "dragging") return state;
  const deltaX = x - state.startX;
  const deltaY = y - state.startY;
  if (state.phase === "tracking") {
    if (
      Math.abs(deltaX) < mobileRowAxisThreshold &&
      Math.abs(deltaY) < mobileRowAxisThreshold
    )
      return state;
    if (
      Math.abs(deltaY) >= Math.abs(deltaX) ||
      (state.startOffset === 0 && deltaX > 0)
    )
      return { phase: "cancelled", revealed: state.startOffset > 0 };
  }
  return {
    ...state,
    phase: "dragging",
    offset: clamp(state.startOffset - deltaX, 0, state.rowWidth),
  };
}

export function releaseMobileRowSwipe(
  state: MobileRowSwipeState,
  releaseVelocityX = 0,
): MobileRowSwipeRelease {
  if (state.phase === "idle" || state.phase === "cancelled") return "reset";
  if (state.phase === "tracking") return "tap";
  if (state.kind === "direct" && state.offset >= state.rowWidth * 0.6)
    return "close";
  if (state.kind === "channel" && state.offset >= state.rowWidth * 0.6)
    return "reveal";
  if (releaseVelocityX <= -0.25 || state.offset >= mobileRowActionWidth * 0.4)
    return "reveal";
  return "reset";
}

export function cancelledMobileRowSwipe(
  state: MobileRowSwipeState,
): "reveal" | "reset" {
  if (
    (state.phase === "tracking" || state.phase === "dragging") &&
    state.startOffset > 0
  )
    return "reveal";
  return "reset";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
