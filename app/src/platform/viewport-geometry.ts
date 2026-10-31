import {
  KeyboardMotionController,
  selectKeyboardMotion,
} from "./keyboard-motion";

export type ViewportGeometry =
  | { readonly keyboard: "closed" }
  | {
      readonly keyboard: "open";
      readonly height: number;
    };

export const appGeometryChangeEvent = "weblounge:app-geometry-change";
export const keyboardGeometryMeasuredEvent =
  "weblounge:keyboard-geometry-measured";
const cachedKeyboardOpenEvent = "weblounge:cached-keyboard-open";

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
  readonly prefersReducedMotion?: () => boolean;
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

const cachedHeights = new WeakMap<Window, Map<string, number>>();
const cachedClosedHeights = new WeakMap<Window, Map<string, number>>();

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

export function cacheKeyboardClosedHeight(
  browserWindow: Window,
  height: number,
): void {
  if (height <= 0) return;
  const heights =
    cachedClosedHeights.get(browserWindow) ?? new Map<string, number>();
  heights.set(orientation(browserWindow), height);
  cachedClosedHeights.set(browserWindow, heights);
}

export function keyboardCloseDistance(
  browserWindow: Window,
  openHeight: number,
  fallbackClosedHeight = browserWindow.innerHeight,
): number {
  const closedHeight =
    cachedClosedHeights.get(browserWindow)?.get(orientation(browserWindow)) ??
    fallbackClosedHeight;
  return Math.max(0, closedHeight - openHeight);
}

export function observeViewportGeometry(
  root: HTMLElement,
  browserWindow: Window,
  {
    onScreenKeyboard = () => true,
    prefersReducedMotion = () => false,
  }: ViewportObserverOptions = {},
): () => void {
  const viewport = browserWindow.visualViewport;
  if (viewport === null || viewport === undefined) return () => {};
  const keyboard = virtualKeyboardFor(browserWindow.navigator);
  const previousOverlay = keyboard?.overlaysContent;
  if (keyboard !== undefined && onScreenKeyboard())
    keyboard.overlaysContent = true;
  const motion = new KeyboardMotionController(
    browserWindow,
    selectKeyboardMotion(
      browserWindow.navigator.userAgent,
      keyboard !== undefined,
    ),
    prefersReducedMotion,
  );
  let published = "";
  let publishedGeometry: ViewportGeometry = { keyboard: "closed" };
  let frame = 0;
  let stableFrames = 0;
  let settleUntil = 0;
  let expectedKeyboard: ViewportGeometry["keyboard"] | undefined;
  let pendingGeometry: ViewportGeometry | undefined;
  let closeFrame = 0;
  let closing = false;
  let closeLayoutCommitted = false;
  let closedGeometryVerified = false;
  let pendingClosedHeight: number | undefined;
  let pointerMayFocus = false;
  let awaitingMeasuredOpen = false;
  let correctingPan = false;
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
  // iOS can reveal a focused field by panning instead of resizing, while WebKit
  // exposes neither interactive-widget nor the VirtualKeyboard API. We undo the
  // pan without ever publishing its stale offset, size to the visual viewport,
  // and re-measure after its events because their geometry can be stale.
  // Pointer-activated text focus gets a bounded fallback until the expected
  // keyboard state is stable; other changes stop after two stable frames.
  // Upstream WebKit bugs:
  // - https://bugs.webkit.org/show_bug.cgi?id=254861
  // - https://bugs.webkit.org/show_bug.cgi?id=259770
  // - https://bugs.webkit.org/show_bug.cgi?id=230225
  const publish = (geometry: ViewportGeometry) => {
    const key = JSON.stringify(geometry);
    if (key === published) return false;
    published = key;
    publishedGeometry = geometry;
    pendingGeometry = undefined;
    if (geometry.keyboard === "closed") {
      closing = false;
      closeLayoutCommitted = false;
      closedGeometryVerified = false;
      pendingClosedHeight = undefined;
    }
    applyGeometry(root, geometry);
    if (geometry.keyboard === "closed")
      cacheKeyboardClosedHeight(
        browserWindow,
        root.getBoundingClientRect().height,
      );
    browserWindow.dispatchEvent(new Event(appGeometryChangeEvent));
    return true;
  };
  const acceptMeasuredOpen = (height: number) => {
    awaitingMeasuredOpen = false;
    cacheKeyboardHeight(browserWindow, height);
    browserWindow.dispatchEvent(new Event(keyboardGeometryMeasuredEvent));
  };
  const commitClosedLayout = () => {
    closeLayoutCommitted = true;
    if (
      closedGeometryVerified ||
      resolveViewportGeometry(measure()).keyboard === "closed"
    ) {
      publish({ keyboard: "closed" });
      return;
    }
    prepareGeometry(
      root,
      { keyboard: "closed" },
      pendingClosedHeight ?? browserWindow.innerHeight,
    );
  };
  const update = () => {
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
      expectedKeyboard === "open" || keyboard !== undefined ? 0 : undefined,
    );
    const key = JSON.stringify(geometry);
    if (key === published) {
      if (geometry.keyboard === "open" && awaitingMeasuredOpen)
        acceptMeasuredOpen(geometry.height);
      return { changed: false, geometry };
    }
    if (JSON.stringify(pendingGeometry) === key) {
      if (geometry.keyboard === "closed") {
        closedGeometryVerified = true;
        if (closeLayoutCommitted) publish(geometry);
      }
      return { changed: false, geometry };
    }
    const commit = () => publish(geometry);
    pendingGeometry = geometry;
    if (geometry.keyboard === "open") {
      pendingClosedHeight = undefined;
      const beforeHeight = root.getBoundingClientRect().height;
      cacheKeyboardClosedHeight(browserWindow, beforeHeight);
      motion.open(
        {
          afterHeight: geometry.height,
          beforeHeight,
          viewportOffsetTop: panned
            ? Math.max(1, initial.viewport.offsetTop, initial.scrollY)
            : 0,
        },
        () => prepareGeometry(root, geometry, beforeHeight),
        commit,
      );
      if (awaitingMeasuredOpen) acceptMeasuredOpen(geometry.height);
    } else {
      closeLayoutCommitted = false;
      closedGeometryVerified = true;
      const openHeight =
        publishedGeometry.keyboard === "open"
          ? publishedGeometry.height
          : root.getBoundingClientRect().height;
      const distance =
        publishedGeometry.keyboard === "open"
          ? keyboardCloseDistance(browserWindow, openHeight)
          : 0;
      pendingClosedHeight = openHeight + distance;
      motion.beginClose(
        distance,
        () => prepareGeometry(root, geometry, openHeight),
        commitClosedLayout,
      );
    }
    return { changed: true, geometry };
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
      frame = browserWindow.requestAnimationFrame(settle);
    } else {
      expectedKeyboard = undefined;
    }
  };
  const measuredKeyboardIsOpen = () =>
    resolveViewportGeometry(measure()).keyboard === "open";
  const keepKeyboardOpen = () => {
    if (closeFrame !== 0) {
      browserWindow.cancelAnimationFrame(closeFrame);
      closeFrame = 0;
    }
    closing = false;
    pendingGeometry = undefined;
    closeLayoutCommitted = false;
    closedGeometryVerified = false;
    pendingClosedHeight = undefined;
    if (expectedKeyboard === "closed") expectedKeyboard = undefined;
    motion.keepOpen();
    applyGeometry(root, publishedGeometry);
  };
  const onChange = (event?: Event) => {
    if (
      closing &&
      (event?.type === "resize" || event?.type === "geometrychange") &&
      measuredKeyboardIsOpen()
    )
      keepKeyboardOpen();
    if (correctingPan) {
      stableFrames = 0;
      if (frame === 0) frame = browserWindow.requestAnimationFrame(settle);
      return;
    }
    update();
    stableFrames = 0;
    if (frame === 0) frame = browserWindow.requestAnimationFrame(settle);
  };
  const expectKeyboard = (keyboard: ViewportGeometry["keyboard"]) => {
    expectedKeyboard = keyboard;
    settleUntil = browserWindow.performance.now() + focusSettleMilliseconds;
    if (keyboard === "open") awaitingMeasuredOpen = true;
  };
  const onPointerDown = (event: Event) => {
    if (!onScreenKeyboard()) return;
    pointerMayFocus = true;
    if (keyboardField(event.target)) {
      expectKeyboard("open");
      onChange();
    }
  };
  const clearPointerFocus = () => {
    browserWindow.queueMicrotask(() => {
      pointerMayFocus = false;
    });
  };
  const onWindowChange = (event: Event) => {
    if (
      event.type === "scroll" &&
      event.target !== browserWindow &&
      event.target !== browserWindow.document
    )
      return;
    if (event.type === "focusin" && keyboardField(event.target)) {
      if (closeFrame !== 0 || closing) {
        keepKeyboardOpen();
        expectKeyboard("open");
      } else if (pointerMayFocus) {
        expectKeyboard("open");
      }
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
      closeFrame = browserWindow.requestAnimationFrame(() => {
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
        expectKeyboard("closed");
        if (publishedGeometry.keyboard === "open") {
          pendingGeometry = { keyboard: "closed" };
          closeLayoutCommitted = false;
          closedGeometryVerified = false;
          const openHeight = publishedGeometry.height;
          const distance = keyboardCloseDistance(browserWindow, openHeight);
          pendingClosedHeight = openHeight + distance;
          motion.beginClose(
            distance,
            () => prepareGeometry(root, { keyboard: "closed" }, openHeight),
            commitClosedLayout,
          );
        }
        onChange();
      });
      return;
    }
    onChange(event);
  };
  const onCachedOpen = (event: Event) => {
    const height = (event as CustomEvent<number>).detail;
    expectKeyboard("open");
    pendingClosedHeight = undefined;
    const beforeHeight = root.getBoundingClientRect().height;
    cacheKeyboardClosedHeight(browserWindow, beforeHeight);
    pendingGeometry = { keyboard: "open", height };
    motion.open(
      {
        afterHeight: height,
        beforeHeight,
        viewportOffsetTop: 0,
      },
      () => prepareGeometry(root, { keyboard: "open", height }, beforeHeight),
      () => publish({ keyboard: "open", height }),
    );
  };
  const onOrientationChange = () => {
    motion.cancel();
    onChange();
  };
  const viewportEvents = ["resize", "scroll"] as const;
  const windowEvents = ["resize", "scroll", "focusin", "focusout"] as const;
  for (const type of viewportEvents) viewport.addEventListener(type, onChange);
  keyboard?.addEventListener("geometrychange", onChange);
  for (const type of windowEvents)
    browserWindow.addEventListener(type, onWindowChange);
  browserWindow.addEventListener("pointerdown", onPointerDown);
  browserWindow.addEventListener("pointerup", clearPointerFocus);
  browserWindow.addEventListener("pointercancel", clearPointerFocus);
  browserWindow.addEventListener(cachedKeyboardOpenEvent, onCachedOpen);
  browserWindow.addEventListener("orientationchange", onOrientationChange);
  update();
  return () => {
    if (frame !== 0) browserWindow.cancelAnimationFrame(frame);
    if (closeFrame !== 0) browserWindow.cancelAnimationFrame(closeFrame);
    for (const type of viewportEvents)
      viewport.removeEventListener(type, onChange);
    keyboard?.removeEventListener("geometrychange", onChange);
    for (const type of windowEvents)
      browserWindow.removeEventListener(type, onWindowChange);
    browserWindow.removeEventListener("pointerdown", onPointerDown);
    browserWindow.removeEventListener("pointerup", clearPointerFocus);
    browserWindow.removeEventListener("pointercancel", clearPointerFocus);
    browserWindow.removeEventListener(cachedKeyboardOpenEvent, onCachedOpen);
    browserWindow.removeEventListener("orientationchange", onOrientationChange);
    motion.cancel();
    if (keyboard !== undefined && previousOverlay !== undefined)
      keyboard.overlaysContent = previousOverlay;
    delete root.dataset.keyboard;
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

function applyGeometry(root: HTMLElement, geometry: ViewportGeometry): void {
  root.dataset.keyboard = geometry.keyboard;
  if (geometry.keyboard === "closed") {
    clearOpenGeometry(root);
    return;
  }
  root.style.setProperty("--wl-app-height", `${geometry.height}px`);
  root.style.setProperty("--wl-app-top", "0px");
}

function prepareGeometry(
  root: HTMLElement,
  geometry: ViewportGeometry,
  retainedHeight: number,
): void {
  root.dataset.keyboard = geometry.keyboard;
  root.style.setProperty("--wl-app-height", `${retainedHeight}px`);
  root.style.setProperty("--wl-app-top", "0px");
  root.ownerDocument.defaultView?.dispatchEvent(
    new Event(appGeometryChangeEvent),
  );
}

function clearOpenGeometry(root: HTMLElement): void {
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
