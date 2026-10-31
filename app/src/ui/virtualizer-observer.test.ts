import type { Virtualizer } from "@tanstack/solid-virtual";
import { expect, it, vi } from "vitest";
import { observeVirtualizerOffset } from "./virtualizer-observer";

it("reads a layout-clamped offset when the deferred update runs", async () => {
  const element = document.createElement("ol");
  document.body.append(element);
  const instance = {
    options: {
      horizontal: false,
      isRtl: false,
      isScrollingResetDelay: 150,
      useScrollendEvent: false,
    },
    scrollElement: element,
    targetWindow: window,
  } as unknown as Virtualizer<HTMLOListElement, HTMLLIElement>;
  const callback = vi.fn();
  const dispose = observeVirtualizerOffset(instance, callback);

  element.scrollTop = 900;
  element.dispatchEvent(new Event("scroll"));
  element.scrollTop = 120;
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  expect(callback).toHaveBeenLastCalledWith(120, true);
  dispose();
  element.remove();
});
