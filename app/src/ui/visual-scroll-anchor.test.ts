import { expect, it } from "vitest";
import { preserveVisualScrollAnchor } from "./visual-scroll-anchor";

it("preserves a partially visible row through a virtualizer remeasure", () => {
  const scroller = document.createElement("div");
  const anchor = document.createElement("div");
  anchor.dataset.rowKey = "message-12";
  scroller.append(anchor);
  let rowTop = 71;
  scroller.scrollTop = 100;
  scroller.getBoundingClientRect = () => rect(0, 200);
  anchor.getBoundingClientRect = () => rect(rowTop - scroller.scrollTop, 40);

  preserveVisualScrollAnchor(scroller, () => {
    rowTop += 14;
  });

  expect(scroller.scrollTop).toBe(114);
  expect(anchor.getBoundingClientRect().top).toBe(-29);
});

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
