export type ViewportGeometry =
  | { readonly keyboard: "closed" }
  | {
      readonly keyboard: "open";
      readonly height: number;
    };

export const appGeometryChangeEvent = "weblounge:app-geometry-change";
export const keyboardGeometryMeasuredEvent =
  "weblounge:keyboard-geometry-measured";
export const keyboardLayoutWillCommitEvent =
  "weblounge:keyboard-layout-will-commit";
export const keyboardLayoutCommitEvent = "weblounge:keyboard-layout-commit";
export const keyboardRollbackDecisionEvent =
  "weblounge:keyboard-rollback-decision";
const cachedKeyboardOpenEvent = "weblounge:cached-keyboard-open";

export interface AppGeometryChange {
  readonly geometry: ViewportGeometry;
  readonly owner: HTMLElement;
}

export type KeyboardLayoutCommitSource = "cached" | "measured" | "rollback";

export type KeyboardRollbackReason =
  | "focus-left-keyboard-field"
  | "pointer-canceled"
  | "pointer-ended-without-focus";

export interface KeyboardLayoutCommit {
  readonly geometry: ViewportGeometry;
  readonly source: KeyboardLayoutCommitSource;
  readonly rollbackReason?: KeyboardRollbackReason;
}

export interface KeyboardLayoutWillCommit extends KeyboardLayoutCommit {
  readonly owner: HTMLElement;
  readonly previousGeometry: ViewportGeometry;
}

export interface KeyboardRollbackDecision {
  readonly outcome: "deferred";
  readonly reason: KeyboardRollbackReason;
}

export interface ViewportMeasurements {
  readonly layoutHeight: number;
  readonly scrollY: number;
  readonly viewport: Pick<VisualViewport, "height" | "offsetTop" | "scale">;
}

const keyboardThreshold = 120;
const settledFrames = 2;
// Longer than the iOS keyboard's slide, which can finish without any further
// viewport event.
const focusSettleMilliseconds = 1000;
const keyboardInputTypes = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

export function resolveViewportGeometry(
  { layoutHeight, viewport }: ViewportMeasurements,
  threshold = keyboardThreshold,
): ViewportGeometry {
  if (zoomed(viewport) || layoutHeight - viewport.height <= threshold) {
    return { keyboard: "closed" };
  }
  return { keyboard: "open", height: viewport.height };
}

// iOS reveals a focused field by panning the visual viewport or scrolling the
// document, even when nothing overflows; the app is already sized to the
// visible area, so a pan only hides the header. Negative values are rubber-band
// overscroll, which settles by itself.
export function documentPanned({
  scrollY,
  viewport,
}: ViewportMeasurements): boolean {
  if (zoomed(viewport)) return false;
  return scrollY >= 1 || viewport.offsetTop >= 1;
}

export interface ViewportObserverOptions {
  readonly onScreenKeyboard?: () => boolean;
}

export function shouldBeginKeyboardClose(
  target: EventTarget | null,
  relatedTarget: EventTarget | null,
  activeElement: Element | null,
  keyboardWasOpen: boolean,
): boolean {
  return (
    keyboardWasOpen &&
    keyboardField(target) &&
    !keyboardField(relatedTarget) &&
    !keyboardField(activeElement)
  );
}

export function keyboardSurfaceOwner(
  target: EventTarget | null,
  root: HTMLElement,
): HTMLElement {
  return target instanceof Element
    ? (target.closest<HTMLElement>("[data-keyboard-surface]") ?? root)
    : root;
}

const cachedHeights = new WeakMap<Window, Map<string, number>>();

export function cacheKeyboardHeight(
  browserWindow: Window,
  height: number,
): void {
  const heights = cachedHeights.get(browserWindow) ?? new Map<string, number>();
  heights.set(orientation(browserWindow), height);
  cachedHeights.set(browserWindow, heights);
}

export function requestCachedKeyboardOpen(browserWindow: Window): boolean {
  const height = cachedHeights
    .get(browserWindow)
    ?.get(orientation(browserWindow));
  if (height === undefined) return false;
  browserWindow.dispatchEvent(
    new CustomEvent<number>(cachedKeyboardOpenEvent, { detail: height }),
  );
  return true;
}

export function observeViewportGeometry(
  root: HTMLElement,
  browserWindow: Window,
  { onScreenKeyboard = () => true }: ViewportObserverOptions = {},
): () => void {
  const viewport = browserWindow.visualViewport;
  if (viewport === null || viewport === undefined) return () => {};
  const keyboard = virtualKeyboardFor(browserWindow.navigator);
  const previousOverlay = keyboard?.overlaysContent;
  if (keyboard !== undefined && onScreenKeyboard())
    keyboard.overlaysContent = true;
  let published = "";
  let frame = 0;
  let stableFrames = 0;
  let settleUntil = 0;
  let expectedKeyboard: ViewportGeometry["keyboard"] | undefined;
  let closeFrame = 0;
  let pointerFocusFrame = 0;
  let owner: HTMLElement | undefined;
  let publishedOwner: HTMLElement | undefined;
  let closing = false;
  let pointerMayFocus = false;
  let awaitingMeasuredOpen = false;
  let correctingPan = false;
  let publishedGeometry: ViewportGeometry = { keyboard: "closed" };
  const measure = (): ViewportMeasurements => {
    const keyboardHeight = keyboard?.boundingRect.height ?? 0;
    return {
      layoutHeight: browserWindow.innerHeight,
      scrollY: browserWindow.scrollY,
      viewport:
        keyboardHeight > 0
          ? {
              height: browserWindow.innerHeight - keyboardHeight,
              offsetTop: 0,
              scale: 1,
            }
          : {
              height: viewport.height,
              offsetTop: viewport.offsetTop,
              scale: viewport.scale,
            },
    };
  };
  const measuredGeometry = () =>
    resolveViewportGeometry(measure(), keyboard !== undefined ? 0 : undefined);
  const announceLayoutCommit = (
    geometry: ViewportGeometry,
    source: KeyboardLayoutCommitSource,
    rollbackReason?: KeyboardRollbackReason,
  ) => {
    const detail: KeyboardLayoutCommit = {
      geometry,
      source,
      ...(rollbackReason === undefined ? {} : { rollbackReason }),
    };
    browserWindow.dispatchEvent(
      new CustomEvent<KeyboardLayoutCommit>(keyboardLayoutCommitEvent, {
        detail,
      }),
    );
  };
  // iOS can reveal a focused field by panning instead of resizing, while WebKit
  // exposes neither interactive-widget nor the VirtualKeyboard API. We undo the
  // pan without ever publishing its stale offset, size to the visual viewport,
  // and re-measure after its events because their geometry can be stale.
  // Text focus gets a bounded fallback until the expected keyboard state is
  // stable; other changes stop after two stable frames.
  // Upstream WebKit bugs:
  // - https://bugs.webkit.org/show_bug.cgi?id=254861
  // - https://bugs.webkit.org/show_bug.cgi?id=259770
  // - https://bugs.webkit.org/show_bug.cgi?id=230225
  const publish = (
    geometry: ViewportGeometry,
    source: KeyboardLayoutCommitSource,
    rollbackReason?: KeyboardRollbackReason,
  ) => {
    const layoutHeight = browserWindow.innerHeight;
    const activeElement = browserWindow.document.activeElement;
    if (geometry.keyboard === "closed" && keyboardField(activeElement)) {
      const measured = measuredGeometry();
      if (measured.keyboard === "open") {
        owner = keyboardSurfaceOwner(activeElement, root);
        geometry = measured;
      }
    }
    const key = JSON.stringify(geometry);
    const eventOwner = owner ?? publishedOwner ?? root;
    const sameLayout =
      key === published &&
      (geometry.keyboard === "closed" || eventOwner === publishedOwner);
    const announce = () =>
      announceLayoutCommit(geometry, source, rollbackReason);
    if (sameLayout) {
      if (geometry.keyboard === "closed") {
        applyGeometry(root, geometry, eventOwner, layoutHeight);
        publishedOwner?.removeAttribute("data-keyboard-owner");
        publishedOwner = undefined;
      }
      if (source !== "measured") announce();
      return false;
    }
    const willCommit: KeyboardLayoutWillCommit = {
      geometry,
      owner: eventOwner,
      previousGeometry: publishedGeometry,
      source,
      ...(rollbackReason === undefined ? {} : { rollbackReason }),
    };
    browserWindow.dispatchEvent(
      new CustomEvent<KeyboardLayoutWillCommit>(keyboardLayoutWillCommitEvent, {
        detail: willCommit,
      }),
    );
    published = key;
    if (geometry.keyboard === "open" && publishedOwner !== eventOwner) {
      publishedOwner?.removeAttribute("data-keyboard-owner");
      eventOwner.setAttribute("data-keyboard-owner", "true");
    }
    applyGeometry(root, geometry, eventOwner, layoutHeight);
    publishedGeometry = geometry;
    publishedOwner = geometry.keyboard === "open" ? eventOwner : undefined;
    browserWindow.dispatchEvent(
      new CustomEvent<AppGeometryChange>(appGeometryChangeEvent, {
        detail: { geometry, owner: eventOwner },
      }),
    );
    if (geometry.keyboard === "closed")
      eventOwner.removeAttribute("data-keyboard-owner");
    announce();
    return true;
  };
  const acceptMeasuredOpen = (height: number) => {
    awaitingMeasuredOpen = false;
    expectedKeyboard = undefined;
    cacheKeyboardHeight(browserWindow, height);
    browserWindow.dispatchEvent(new Event(keyboardGeometryMeasuredEvent));
  };
  const update = (acceptOpenReconcile = true) => {
    const initial = measure();
    const panned = documentPanned(initial);
    if (panned) {
      correctingPan = true;
      browserWindow.scrollTo(0, 0);
      correctingPan = false;
    }
    const measured = measure();
    const geometry = resolveViewportGeometry(
      measured,
      keyboard !== undefined ? 0 : undefined,
    );
    const focusedField = keyboardField(browserWindow.document.activeElement);
    if (geometry.keyboard === "open" && !focusedField)
      return { changed: false, geometry };
    if (focusedField && owner === undefined)
      owner = keyboardSurfaceOwner(browserWindow.document.activeElement, root);
    if (geometry.keyboard === "open" && focusedField) {
      cancelPendingRollbacks();
      closing = false;
    }
    const key = JSON.stringify(geometry);
    if (
      geometry.keyboard === "open" &&
      root.dataset.keyboard === "open" &&
      key !== published &&
      !acceptOpenReconcile
    )
      return { changed: false, geometry };
    if (geometry.keyboard === "open") {
      if (awaitingMeasuredOpen) acceptMeasuredOpen(geometry.height);
      else cacheKeyboardHeight(browserWindow, geometry.height);
    }
    if (closing) {
      if (geometry.keyboard === "closed") {
        closing = false;
        expectedKeyboard = undefined;
      }
      return { changed: false, geometry };
    }
    if (expectedKeyboard === "open" && geometry.keyboard === "closed")
      return { changed: false, geometry };
    return { changed: publish(geometry, "measured"), geometry };
  };
  // WebKit can fire viewport events before it updates the values they report,
  // so re-measure on the following frames until the geometry stops changing.
  const settle = (now: number) => {
    frame = 0;
    const result = update();
    stableFrames = result.changed ? 0 : stableFrames + 1;
    const awaitingKeyboard =
      expectedKeyboard !== undefined &&
      result.geometry.keyboard !== expectedKeyboard &&
      now < settleUntil;
    if (stableFrames < settledFrames || awaitingKeyboard) {
      scheduleSettle();
    } else {
      expectedKeyboard = undefined;
      root.removeAttribute("data-keyboard-watch");
    }
  };
  const scheduleSettle = () => {
    root.setAttribute("data-keyboard-watch", "active");
    if (frame === 0) frame = browserWindow.requestAnimationFrame(settle);
  };
  const keepKeyboardOpen = () => {
    if (closeFrame !== 0) {
      browserWindow.cancelAnimationFrame(closeFrame);
      closeFrame = 0;
    }
    closing = false;
    if (expectedKeyboard === "closed") expectedKeyboard = undefined;
    const measured = measuredGeometry();
    if (measured.keyboard === "open") publish(measured, "measured");
  };
  const onChange = () => {
    if (correctingPan) {
      stableFrames = 0;
      scheduleSettle();
      return;
    }
    update(false);
    stableFrames = 0;
    scheduleSettle();
  };
  const expectKeyboard = (keyboard: ViewportGeometry["keyboard"]) => {
    expectedKeyboard = keyboard;
    settleUntil = browserWindow.performance.now() + focusSettleMilliseconds;
    if (keyboard === "open") awaitingMeasuredOpen = true;
  };
  const onPointerDown = (event: Event) => {
    if (!onScreenKeyboard()) return;
    if (keyboardField(event.target) || keyboardFocusSurface(event.target)) {
      pointerMayFocus = true;
      expectKeyboard("open");
    }
  };
  const cancelPointerRollback = () => {
    if (pointerFocusFrame === 0) return;
    browserWindow.cancelAnimationFrame(pointerFocusFrame);
    pointerFocusFrame = 0;
  };
  const cancelPendingRollbacks = () => {
    cancelPointerRollback();
    if (closeFrame === 0) return;
    browserWindow.cancelAnimationFrame(closeFrame);
    closeFrame = 0;
  };
  const reconcileRollback = (reason: KeyboardRollbackReason) => {
    const activeElement = browserWindow.document.activeElement;
    const measured = measuredGeometry();
    if (keyboardField(activeElement)) {
      owner = keyboardSurfaceOwner(activeElement, root);
      closing = false;
      if (measured.keyboard === "open") {
        expectedKeyboard = undefined;
        awaitingMeasuredOpen = false;
        cacheKeyboardHeight(browserWindow, measured.height);
        publish(measured, "rollback", reason);
        return;
      }
      expectKeyboard("open");
      stableFrames = 0;
      browserWindow.dispatchEvent(
        new CustomEvent<KeyboardRollbackDecision>(
          keyboardRollbackDecisionEvent,
          { detail: { outcome: "deferred", reason } },
        ),
      );
      scheduleSettle();
      return;
    }
    publish({ keyboard: "closed" }, "rollback", reason);
  };
  const rollbackPointerFocus = (reason: KeyboardRollbackReason) => {
    cancelPointerRollback();
    pointerMayFocus = false;
    if (expectedKeyboard === "open") expectedKeyboard = undefined;
    awaitingMeasuredOpen = false;
    reconcileRollback(reason);
  };
  const finishPointerFocus = () => {
    if (!pointerMayFocus) return;
    if (pointerFocusFrame !== 0)
      browserWindow.cancelAnimationFrame(pointerFocusFrame);
    let scheduledPointerFocusFrame = 0;
    scheduledPointerFocusFrame = browserWindow.requestAnimationFrame(() => {
      if (pointerFocusFrame !== scheduledPointerFocusFrame) return;
      pointerFocusFrame = 0;
      if (!pointerMayFocus) return;
      rollbackPointerFocus("pointer-ended-without-focus");
    });
    pointerFocusFrame = scheduledPointerFocusFrame;
  };
  const cancelPointerFocus = () => {
    browserWindow.queueMicrotask(() => {
      if (pointerMayFocus) rollbackPointerFocus("pointer-canceled");
    });
  };
  const onWindowChange = (event: Event) => {
    if (
      event.type === "scroll" &&
      event.target !== browserWindow &&
      event.target !== browserWindow.document
    )
      return;
    if (
      onScreenKeyboard() &&
      event.type === "focusin" &&
      keyboardField(event.target)
    ) {
      const pointerActivated = pointerMayFocus;
      cancelPointerRollback();
      const nextOwner = keyboardSurfaceOwner(event.target, root);
      if (owner !== nextOwner) {
        owner?.removeAttribute("data-keyboard-owner");
        owner = nextOwner;
        owner.setAttribute("data-keyboard-owner", "true");
      }
      const resumesClosingKeyboard = closeFrame !== 0 || closing;
      if (resumesClosingKeyboard) {
        keepKeyboardOpen();
      }
      expectKeyboard("open");
      if (pointerActivated && owner === root)
        requestCachedKeyboardOpen(browserWindow);
      pointerMayFocus = false;
    }
    const mayClose =
      onScreenKeyboard() &&
      event.type === "focusout" &&
      keyboardField(event.target) &&
      !keyboardField((event as FocusEvent).relatedTarget) &&
      (root.dataset.keyboard === "open" || expectedKeyboard === "open");
    if (mayClose) {
      const focusEvent = event as FocusEvent;
      if (closeFrame !== 0) browserWindow.cancelAnimationFrame(closeFrame);
      let scheduledCloseFrame = 0;
      scheduledCloseFrame = browserWindow.requestAnimationFrame(() => {
        if (closeFrame !== scheduledCloseFrame) return;
        closeFrame = 0;
        if (
          !shouldBeginKeyboardClose(
            focusEvent.target,
            focusEvent.relatedTarget,
            browserWindow.document.activeElement,
            root.dataset.keyboard === "open" || expectedKeyboard === "open",
          )
        )
          return;
        closing = true;
        owner?.removeAttribute("data-keyboard-owner");
        owner = undefined;
        expectKeyboard("closed");
        reconcileRollback("focus-left-keyboard-field");
        onChange();
      });
      closeFrame = scheduledCloseFrame;
      return;
    }
    onChange();
  };
  const rearmFocusedKeyboard = () => {
    if (
      !onScreenKeyboard() ||
      !keyboardField(browserWindow.document.activeElement)
    )
      return;
    cancelPendingRollbacks();
    owner = keyboardSurfaceOwner(browserWindow.document.activeElement, root);
    owner.setAttribute("data-keyboard-owner", "true");
    closing = false;
    expectKeyboard("open");
    onChange();
  };
  const onVisibilityChange = () => {
    if (browserWindow.document.visibilityState === "visible")
      rearmFocusedKeyboard();
  };
  const onCachedOpen = (event: Event) => {
    if (!keyboardField(browserWindow.document.activeElement) || owner !== root)
      return;
    const height = (event as CustomEvent<number>).detail;
    expectKeyboard("open");
    closing = false;
    publish({ keyboard: "open", height }, "cached");
  };
  const onOrientationChange = () => onChange();
  const viewportEvents = ["resize", "scroll"] as const;
  const windowEvents = ["resize", "scroll", "focusin", "focusout"] as const;
  for (const type of viewportEvents) viewport.addEventListener(type, onChange);
  keyboard?.addEventListener("geometrychange", onChange);
  for (const type of windowEvents)
    browserWindow.addEventListener(type, onWindowChange);
  browserWindow.addEventListener("pointerdown", onPointerDown);
  browserWindow.addEventListener("pointerup", finishPointerFocus);
  browserWindow.addEventListener("pointercancel", cancelPointerFocus);
  browserWindow.addEventListener(cachedKeyboardOpenEvent, onCachedOpen);
  browserWindow.addEventListener("orientationchange", onOrientationChange);
  browserWindow.addEventListener("pageshow", rearmFocusedKeyboard);
  browserWindow.document.addEventListener(
    "visibilitychange",
    onVisibilityChange,
  );
  update();
  return () => {
    if (frame !== 0) browserWindow.cancelAnimationFrame(frame);
    if (closeFrame !== 0) browserWindow.cancelAnimationFrame(closeFrame);
    if (pointerFocusFrame !== 0)
      browserWindow.cancelAnimationFrame(pointerFocusFrame);
    for (const type of viewportEvents)
      viewport.removeEventListener(type, onChange);
    keyboard?.removeEventListener("geometrychange", onChange);
    for (const type of windowEvents)
      browserWindow.removeEventListener(type, onWindowChange);
    browserWindow.removeEventListener("pointerdown", onPointerDown);
    browserWindow.removeEventListener("pointerup", finishPointerFocus);
    browserWindow.removeEventListener("pointercancel", cancelPointerFocus);
    browserWindow.removeEventListener(cachedKeyboardOpenEvent, onCachedOpen);
    browserWindow.removeEventListener("orientationchange", onOrientationChange);
    browserWindow.removeEventListener("pageshow", rearmFocusedKeyboard);
    browserWindow.document.removeEventListener(
      "visibilitychange",
      onVisibilityChange,
    );
    if (keyboard !== undefined && previousOverlay !== undefined)
      keyboard.overlaysContent = previousOverlay;
    owner?.removeAttribute("data-keyboard-owner");
    publishedOwner?.removeAttribute("data-keyboard-owner");
    owner = undefined;
    publishedOwner = undefined;
    delete root.dataset.keyboard;
    root.removeAttribute("data-keyboard-watch");
    clearOpenGeometry(root);
  };
}

function keyboardField(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement)
    return (
      !target.disabled &&
      !target.readOnly &&
      keyboardInputTypes.has(target.type)
    );
  if (target instanceof HTMLTextAreaElement)
    return !target.disabled && !target.readOnly;
  return (
    target instanceof HTMLElement &&
    target.matches("[contenteditable]:not([contenteditable='false'])")
  );
}

function keyboardFocusSurface(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-keyboard-focus-surface]") !== null
  );
}

function applyGeometry(
  root: HTMLElement,
  geometry: ViewportGeometry,
  owner: HTMLElement,
  layoutHeight: number,
): void {
  root.dataset.keyboard = geometry.keyboard;
  if (geometry.keyboard === "closed") {
    clearOpenGeometry(root);
    return;
  }
  root.style.setProperty(
    "--wl-keyboard-inset",
    `${Math.max(0, layoutHeight - geometry.height)}px`,
  );
  if (owner === root) {
    root.style.setProperty("--wl-app-height", `${geometry.height}px`);
    root.style.setProperty("--wl-app-top", "0px");
  } else {
    clearRootGeometry(root);
  }
}

function clearOpenGeometry(root: HTMLElement): void {
  root.style.removeProperty("--wl-keyboard-inset");
  clearRootGeometry(root);
}

function clearRootGeometry(root: HTMLElement): void {
  root.style.removeProperty("--wl-app-height");
  root.style.removeProperty("--wl-app-top");
}

function zoomed(viewport: Pick<VisualViewport, "scale">): boolean {
  return Math.abs(viewport.scale - 1) > 0.01;
}

interface VirtualKeyboardLike extends EventTarget {
  readonly boundingRect: DOMRectReadOnly;
  overlaysContent: boolean;
}

function virtualKeyboardFor(
  browserNavigator: Navigator,
): VirtualKeyboardLike | undefined {
  return (
    browserNavigator as Navigator & {
      readonly virtualKeyboard?: VirtualKeyboardLike;
    }
  ).virtualKeyboard;
}

function orientation(browserWindow: Window): string {
  return browserWindow.innerWidth > browserWindow.innerHeight
    ? "landscape"
    : "portrait";
}
