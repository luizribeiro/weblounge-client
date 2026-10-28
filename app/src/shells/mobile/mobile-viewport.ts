export interface MobileViewport {
  readonly height: number;
  readonly offsetTop: number;
}

export function observeMobileViewport(
  target: Window,
  onChange: (viewport: MobileViewport | undefined) => void,
): () => void {
  const viewport = target.visualViewport;
  if (viewport == null) {
    onChange(undefined);
    return () => {};
  }
  const update = () =>
    onChange({ height: viewport.height, offsetTop: viewport.offsetTop });
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
  };
}
