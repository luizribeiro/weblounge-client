interface TouchMoveDecision {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly keyboardOpen: boolean;
  readonly selectionActive: boolean;
  readonly startTarget: Element | null;
  readonly root: HTMLElement;
  readonly browserWindow: Window;
}

interface ActiveTouch {
  readonly identifier: number;
  readonly startTarget: Element | null;
  readonly x: number;
  readonly y: number;
}

const scrollEpsilon = 1;
const horizontalClaims = new Map<Element, number>();

export function claimHorizontalTouchMove(target: Element | null): () => void {
  if (target === null) return () => {};
  horizontalClaims.set(target, (horizontalClaims.get(target) ?? 0) + 1);
  return () => {
    const remaining = (horizontalClaims.get(target) ?? 1) - 1;
    if (remaining === 0) horizontalClaims.delete(target);
    else horizontalClaims.set(target, remaining);
  };
}

export function shouldLockTouchMove({
  browserWindow,
  deltaX,
  deltaY,
  keyboardOpen,
  root,
  selectionActive,
  startTarget,
}: TouchMoveDecision): boolean {
  if (
    !keyboardOpen ||
    startTarget === null ||
    !root.contains(startTarget) ||
    startTarget.closest("textarea") !== null ||
    selectionActive ||
    Math.abs(deltaY) <= Math.abs(deltaX)
  )
    return false;

  return !canScrollInDirection(startTarget, root, deltaY, browserWindow);
}

export function observeTouchMoveLock(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  const document = browserWindow.document;
  let active: ActiveTouch | undefined;
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      active = undefined;
      return;
    }
    active = {
      identifier: touch.identifier,
      startTarget: eventTarget(event),
      x: touch.clientX,
      y: touch.clientY,
    };
  };
  const onTouchMove = (event: TouchEvent) => {
    const start = active;
    if (start === undefined || event.touches.length !== 1) return;
    const touch = [...event.touches].find(
      (candidate) => candidate.identifier === start.identifier,
    );
    if (touch === undefined) return;
    if (horizontalClaimCovers(start.startTarget)) {
      event.preventDefault();
      return;
    }
    if (
      shouldLockTouchMove({
        browserWindow,
        deltaX: touch.clientX - start.x,
        deltaY: touch.clientY - start.y,
        keyboardOpen:
          root.dataset.input === "touch" && root.dataset.keyboard === "open",
        root,
        selectionActive: selectionContains(
          start.startTarget,
          browserWindow.getSelection(),
        ),
        startTarget: start.startTarget,
      })
    )
      event.preventDefault();
  };
  const clear = () => {
    active = undefined;
  };

  // WebKit only waits for a cancellable touchmove when a non-passive listener
  // covered touchstart. Pointermove runs first, so a horizontal pan can claim
  // the deciding move here before WebKit cancels its pointer stream:
  // https://github.com/w3c/pointerevents/issues/303
  // https://github.com/WebKit/WebKit/blob/b1964c8/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm#L4498-L4518
  // https://github.com/WebKit/WebKit/blob/b1964c8/Source/WebKit/UIProcess/ios/WKContentViewInteraction.mm#L2487-L2493
  // https://github.com/WebKit/WebKit/blob/b1964c8/Source/WebKit/UIProcess/ios/WKContentViewInteraction.mm#L4130-L4136
  // The same listener also prevents keyboard-open document pans. Remove that
  // policy once these WebKit bugs are fixed:
  // https://bugs.webkit.org/show_bug.cgi?id=240860
  // https://bugs.webkit.org/show_bug.cgi?id=271773
  // https://bugs.webkit.org/show_bug.cgi?id=244232
  document.addEventListener("touchstart", onTouchStart, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchmove", onTouchMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener("touchend", clear, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchcancel", clear, {
    capture: true,
    passive: true,
  });
  return () => {
    document.removeEventListener("touchstart", onTouchStart, true);
    document.removeEventListener("touchmove", onTouchMove, true);
    document.removeEventListener("touchend", clear, true);
    document.removeEventListener("touchcancel", clear, true);
  };
}

function horizontalClaimCovers(startTarget: Element | null): boolean {
  if (startTarget === null) return false;
  for (const target of horizontalClaims.keys()) {
    if (target === startTarget || target.contains(startTarget)) return true;
  }
  return false;
}

function canScrollInDirection(
  start: Element,
  root: HTMLElement,
  deltaY: number,
  browserWindow: Window,
): boolean {
  for (let element: Element | null = start; element !== null; ) {
    if (element instanceof HTMLElement && scrollable(element, browserWindow)) {
      if (deltaY > 0 && element.scrollTop > scrollEpsilon) return true;
      if (
        deltaY < 0 &&
        element.scrollTop + element.clientHeight <
          element.scrollHeight - scrollEpsilon
      )
        return true;
    }
    if (element === root) break;
    element = element.parentElement;
  }
  return false;
}

function scrollable(element: HTMLElement, browserWindow: Window): boolean {
  const overflow = browserWindow.getComputedStyle(element).overflowY;
  return (
    (overflow === "auto" || overflow === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

function selectionContains(
  target: Element | null,
  selection: Selection | null,
): boolean {
  return (
    target !== null &&
    selection !== null &&
    !selection.isCollapsed &&
    selection.containsNode(target, true)
  );
}

function eventTarget(event: TouchEvent): Element | null {
  const target = event.composedPath()[0] ?? event.target;
  return target instanceof Element ? target : null;
}
