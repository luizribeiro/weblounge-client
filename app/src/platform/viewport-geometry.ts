export type ViewportGeometry =
  | { readonly keyboard: "closed" }
  | {
      readonly keyboard: "open";
      readonly height: number;
      readonly top: number;
    };

export interface ViewportMeasurements {
  readonly layoutHeight: number;
  readonly viewport: Pick<VisualViewport, "height" | "offsetTop" | "scale">;
}

const keyboardThreshold = 120;

export function resolveViewportGeometry({
  layoutHeight,
  viewport,
}: ViewportMeasurements): ViewportGeometry {
  if (zoomed(viewport) || layoutHeight - viewport.height <= keyboardThreshold) {
    return { keyboard: "closed" };
  }
  return { keyboard: "open", height: viewport.height, top: viewport.offsetTop };
}

export function observeViewportGeometry(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  const viewport = browserWindow.visualViewport;
  if (viewport === null || viewport === undefined) return () => {};
  const update = () => {
    applyGeometry(
      root,
      resolveViewportGeometry({
        layoutHeight: browserWindow.innerHeight,
        viewport,
      }),
    );
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  browserWindow.addEventListener("resize", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    browserWindow.removeEventListener("resize", update);
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
