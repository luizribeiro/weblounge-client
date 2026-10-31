export type KeyboardState = "closed" | "open";

export interface ViewportMeasurements {
  readonly layoutHeight: number;
  readonly screenHeight: number;
  readonly safeTop: number;
  readonly standalone: boolean;
  readonly viewport: Pick<VisualViewport, "height" | "scale">;
}

export interface ViewportGeometry {
  readonly appHeight: number;
  readonly keyboard: KeyboardState;
}

const keyboardThreshold = 120;

export function resolveViewportGeometry(
  measurements: ViewportMeasurements,
): ViewportGeometry {
  const fullHeight =
    measurements.layoutHeight + statusBarShortfall(measurements);
  const { viewport } = measurements;
  const zoomed = Math.abs(viewport.scale - 1) > 0.01;
  if (zoomed || fullHeight - viewport.height <= keyboardThreshold) {
    return { appHeight: fullHeight, keyboard: "closed" };
  }
  return { appHeight: viewport.height, keyboard: "open" };
}

// iOS standalone apps with a black-translucent status bar report a layout
// viewport that starts at the screen top but is shorter by the top safe inset.
function statusBarShortfall(measurements: ViewportMeasurements): number {
  if (!measurements.standalone || measurements.safeTop <= 0) return 0;
  const shortfall = measurements.screenHeight - measurements.layoutHeight;
  return Math.abs(shortfall - measurements.safeTop) <= 1 ? shortfall : 0;
}

export function observeViewportGeometry(
  root: HTMLElement,
  browserWindow: Window,
  isStandalone: () => boolean,
): () => void {
  const viewport = browserWindow.visualViewport;
  if (viewport === null || viewport === undefined) return () => {};
  let safeTop = 0;
  const update = () => {
    const geometry = resolveViewportGeometry({
      layoutHeight: browserWindow.innerHeight,
      screenHeight: orientedScreenHeight(browserWindow),
      safeTop,
      standalone: isStandalone(),
      viewport,
    });
    root.dataset.keyboard = geometry.keyboard;
    root.style.setProperty("--wl-app-height", `${geometry.appHeight}px`);
  };
  const remeasure = () => {
    safeTop = isStandalone() ? measureSafeTop(root) : 0;
    update();
  };
  viewport.addEventListener("resize", update);
  browserWindow.addEventListener("resize", remeasure);
  remeasure();
  return () => {
    viewport.removeEventListener("resize", update);
    browserWindow.removeEventListener("resize", remeasure);
    delete root.dataset.keyboard;
    root.style.removeProperty("--wl-app-height");
  };
}

function orientedScreenHeight(browserWindow: Window): number {
  const { width, height } = browserWindow.screen;
  const landscape = browserWindow.innerWidth > browserWindow.innerHeight;
  return landscape ? Math.min(width, height) : Math.max(width, height);
}

function measureSafeTop(root: HTMLElement): number {
  const probe = root.ownerDocument.createElement("div");
  probe.style.setProperty("position", "absolute");
  probe.style.setProperty("visibility", "hidden");
  probe.style.setProperty("padding-top", "var(--wl-safe-top)");
  root.append(probe);
  const safeTop = Number.parseFloat(getComputedStyle(probe).paddingTop);
  probe.remove();
  return Number.isFinite(safeTop) ? safeTop : 0;
}
