import { expect, it, vi } from "vitest";
import { focusWithoutViewportPan, TouchTapGesture } from "./focus-without-pan";
import { keyboardGeometryMeasuredEvent } from "./viewport-geometry";

it("focuses above the viewport until measured keyboard geometry arrives", () => {
  const field = document.createElement("textarea");
  field.style.transform = "scale(1)";
  const focus = vi.spyOn(field, "focus");

  focusWithoutViewportPan(field, window);

  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(field.style.transform).toBe("translateY(-2000px)");
  window.dispatchEvent(new Event(keyboardGeometryMeasuredEvent));
  expect(field.style.transform).toBe("scale(1)");
});

it("recognizes a short touch within tap slop", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);
  gesture.move(touch(26, 46));

  expect(gesture.end(touch(27, 46), 180)).toBe(true);
});

it("rejects a drag even if it returns near its start", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);
  gesture.move(touch(40, 40));

  expect(gesture.end(touch(22, 40), 180)).toBe(false);
});

it("rejects a long-press without consuming its native behavior", () => {
  const gesture = new TouchTapGesture();
  gesture.begin(touch(20, 40), 100);

  expect(gesture.end(touch(20, 40), 600)).toBe(false);
});

function touch(clientX: number, clientY: number) {
  return { clientX, clientY, identifier: 7 };
}
