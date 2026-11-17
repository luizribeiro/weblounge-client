import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorPopover } from "./anchored-popover";

afterEach(() => {
  document.body.replaceChildren();
});

describe("anchored popover", () => {
  it("places the popover below its invoker through the given properties", () => {
    const invoker = document.createElement("button");
    const popover = document.createElement("div");
    document.body.append(invoker, popover);
    invoker.getBoundingClientRect = () => new DOMRect(300, 100, 20, 20);
    popover.getBoundingClientRect = () => new DOMRect(0, 0, 200, 80);

    anchorPopover(popover, invoker, "--wl-test", vi.fn());

    expect(popover.style.getPropertyValue("--wl-test-left")).toBe("120px");
    expect(popover.style.getPropertyValue("--wl-test-top")).toBe("126px");
  });
});
