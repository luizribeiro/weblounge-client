export type ViewportGeometry =
  | { readonly keyboard: "closed" }
  | {
      readonly keyboard: "open";
      readonly height: number;
      readonly top: number;
    };

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

export function resolveViewportGeometry({
  layoutHeight,
  viewport,
}: ViewportMeasurements): ViewportGeometry {
  if (zoomed(viewport) || layoutHeight - viewport.height <= keyboardThreshold) {
    return { keyboard: "closed" };
  }
  return { keyboard: "open", height: viewport.height, top: viewport.offsetTop };
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

export function observeViewportGeometry(
  root: HTMLElement,
  browserWindow: Window,
  { onScreenKeyboard = () => true }: ViewportObserverOptions = {},
): () => void {
  const viewport = browserWindow.visualViewport;
  if (viewport === null || viewport === undefined) return () => {};
  let published = "";
  let frame = 0;
  let stableFrames = 0;
  let settleUntil = 0;
  let expectedKeyboard: ViewportGeometry["keyboard"] | undefined;
  let pointerMayFocus = false;
  const measure = (): ViewportMeasurements => ({
    layoutHeight: browserWindow.innerHeight,
    scrollY: browserWindow.scrollY,
    viewport,
  });
  // iOS reveals a focused field by panning the document instead of resizing it,
  // and WebKit has neither interactive-widget nor the VirtualKeyboard API, so we
  // undo the pan and size to the visual viewport. Its events can report stale
  // values, or stop before the keyboard settles, hence the re-measuring on the
  // following frames.
  // https://bugs.webkit.org/show_bug.cgi?id=254861
  // https://bugs.webkit.org/show_bug.cgi?id=259770
  // https://bugs.webkit.org/show_bug.cgi?id=230225
  const update = () => {
    if (documentPanned(measure())) browserWindow.scrollTo(0, 0);
    const geometry = resolveViewportGeometry(measure());
    const key = JSON.stringify(geometry);
    if (key === published) return { changed: false, geometry };
    published = key;
    applyGeometry(root, geometry);
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
  const onChange = () => {
    update();
    stableFrames = 0;
    if (frame === 0) frame = browserWindow.requestAnimationFrame(settle);
  };
  const expectKeyboard = (keyboard: ViewportGeometry["keyboard"]) => {
    expectedKeyboard = keyboard;
    settleUntil = browserWindow.performance.now() + focusSettleMilliseconds;
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
    if (
      event.type === "focusin" &&
      pointerMayFocus &&
      keyboardField(event.target)
    )
      expectKeyboard("open");
    if (
      onScreenKeyboard() &&
      event.type === "focusout" &&
      keyboardField(event.target) &&
      !keyboardField((event as FocusEvent).relatedTarget) &&
      (root.dataset.keyboard === "open" || expectedKeyboard === "open")
    )
      expectKeyboard("closed");
    onChange();
  };
  const viewportEvents = ["resize", "scroll"] as const;
  const windowEvents = ["resize", "scroll", "focusin", "focusout"] as const;
  for (const type of viewportEvents) viewport.addEventListener(type, onChange);
  for (const type of windowEvents)
    browserWindow.addEventListener(type, onWindowChange);
  browserWindow.addEventListener("pointerdown", onPointerDown);
  browserWindow.addEventListener("pointerup", clearPointerFocus);
  browserWindow.addEventListener("pointercancel", clearPointerFocus);
  update();
  return () => {
    if (frame !== 0) browserWindow.cancelAnimationFrame(frame);
    for (const type of viewportEvents)
      viewport.removeEventListener(type, onChange);
    for (const type of windowEvents)
      browserWindow.removeEventListener(type, onWindowChange);
    browserWindow.removeEventListener("pointerdown", onPointerDown);
    browserWindow.removeEventListener("pointerup", clearPointerFocus);
    browserWindow.removeEventListener("pointercancel", clearPointerFocus);
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
  root.style.setProperty("--wl-app-top", `${geometry.top}px`);
}

function clearOpenGeometry(root: HTMLElement): void {
  root.style.removeProperty("--wl-app-height");
  root.style.removeProperty("--wl-app-top");
}

function zoomed(viewport: Pick<VisualViewport, "scale">): boolean {
  return Math.abs(viewport.scale - 1) > 0.01;
}
