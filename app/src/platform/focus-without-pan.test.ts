import { expect, it, vi } from "vitest";
import { focusWithoutViewportPan } from "./focus-without-pan";

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
