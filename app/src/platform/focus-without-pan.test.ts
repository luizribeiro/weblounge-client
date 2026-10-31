import { expect, it, vi } from "vitest";
import { focusWithoutViewportPan, TouchTapGesture } from "./focus-without-pan";

it("focuses above the viewport and restores the previous transform next frame", () => {
  const field = document.createElement("textarea");
  field.style.transform = "scale(1)";
  const focus = vi.spyOn(field, "focus");
  let restore: FrameRequestCallback | undefined;
  const browserWindow = new Proxy(window, {
    get(target, property) {
      if (property === "requestAnimationFrame")
        return (callback: FrameRequestCallback) => {
          restore = callback;
          return 1;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  focusWithoutViewportPan(field, browserWindow);

  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(field.style.transform).toBe("translateY(-2000px)");
  restore?.(0);
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
