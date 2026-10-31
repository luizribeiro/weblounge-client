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
// visible area, so any pan only hides the header and must be undone.
export function documentPanned({
  scrollY,
  viewport,
}: ViewportMeasurements): boolean {
  if (zoomed(viewport)) return false;
  return Math.abs(scrollY) >= 1 || Math.abs(viewport.offsetTop) >= 1;
}

export function observeViewportGeometry(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  const viewport = browserWindow.visualViewport;
  if (viewport === null || viewport === undefined) return () => {};
  let published = "";
  let frame = 0;
  let stableFrames = 0;
  const measure = (): ViewportMeasurements => ({
    layoutHeight: browserWindow.innerHeight,
    scrollY: browserWindow.scrollY,
    viewport,
  });
  const update = () => {
    if (documentPanned(measure())) browserWindow.scrollTo(0, 0);
    const geometry = resolveViewportGeometry(measure());
    const key = JSON.stringify(geometry);
    if (key === published) return false;
    published = key;
    applyGeometry(root, geometry);
    return true;
  };
  // WebKit can fire viewport events before it updates the values they report,
  // so re-measure on the following frames until the geometry stops changing.
  const settle = () => {
    frame = 0;
    stableFrames = update() ? 0 : stableFrames + 1;
    if (stableFrames < settledFrames) {
      frame = browserWindow.requestAnimationFrame(settle);
    }
  };
  const onChange = () => {
    update();
    stableFrames = 0;
    if (frame === 0) frame = browserWindow.requestAnimationFrame(settle);
  };
  const viewportEvents = ["resize", "scroll"] as const;
  const windowEvents = ["resize", "scroll", "focusin", "focusout"] as const;
  for (const type of viewportEvents) viewport.addEventListener(type, onChange);
  for (const type of windowEvents)
    browserWindow.addEventListener(type, onChange);
  update();
  return () => {
    if (frame !== 0) browserWindow.cancelAnimationFrame(frame);
    for (const type of viewportEvents)
      viewport.removeEventListener(type, onChange);
    for (const type of windowEvents)
      browserWindow.removeEventListener(type, onChange);
    delete root.dataset.keyboard;
    clearOpenGeometry(root);
  };
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
