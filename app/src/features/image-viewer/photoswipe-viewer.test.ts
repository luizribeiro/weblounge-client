import type PhotoSwipe from "photoswipe";
import { expect, it, vi } from "vitest";
import { fitBoxPadding, isBackdrop, runCommand } from "./photoswipe-viewer";

function fakeViewer(currZoomLevel: number) {
  const slide = {
    currZoomLevel,
    pan: { x: 10, y: -20 },
    panTo: vi.fn(),
    zoomLevels: { initial: 0.5, max: 4 },
    zoomTo: vi.fn(),
  };
  const pswp = { close: vi.fn(), currSlide: slide };
  return { pswp: pswp as unknown as PhotoSwipe, close: pswp.close, slide };
}

it("pads the viewport down to the fit box below the bar", () => {
  const fitBox = document.createElement("div");
  fitBox.getBoundingClientRect = () =>
    ({ bottom: 776, left: 24, right: 1256, top: 72 }) as DOMRect;

  expect(fitBoxPadding(fitBox, { x: 1280, y: 800 })).toEqual({
    bottom: 24,
    left: 24,
    right: 24,
    top: 72,
  });
});

it("treats only the slide area around the image as backdrop", () => {
  const item = document.createElement("div");
  item.className = "pswp__item";
  const image = document.createElement("img");
  image.className = "pswp__img";

  expect(isBackdrop(item)).toBe(true);
  expect(isBackdrop(image)).toBe(false);
  expect(isBackdrop(null)).toBe(false);
});

it("steps zoom, resets to fit and closes", () => {
  const { close, pswp, slide } = fakeViewer(1);

  runCommand(pswp, { kind: "zoom", direction: "in" });
  runCommand(pswp, { kind: "reset" });
  runCommand(pswp, { kind: "close" });

  expect(slide.zoomTo).toHaveBeenNthCalledWith(1, 1.5);
  expect(slide.zoomTo).toHaveBeenNthCalledWith(2, 0.5);
  expect(close).toHaveBeenCalledTimes(1);
});

it("pans only while zoomed past fit", () => {
  const atFit = fakeViewer(0.5);
  runCommand(atFit.pswp, { kind: "pan", x: -80, y: 0 });
  expect(atFit.slide.panTo).not.toHaveBeenCalled();

  const zoomed = fakeViewer(2);
  runCommand(zoomed.pswp, { kind: "pan", x: -80, y: 0 });
  expect(zoomed.slide.panTo).toHaveBeenCalledWith(-70, -20);
});
