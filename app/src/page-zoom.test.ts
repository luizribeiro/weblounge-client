import { expect, it } from "vitest";
import { installPageZoomGuard } from "./page-zoom";

it.each(["gesturestart", "gesturechange"])(
  "prevents WebKit's %s page zoom gesture",
  (type) => {
    const dispose = installPageZoomGuard(document);
    const guarded = new Event(type, { bubbles: true, cancelable: true });
    document.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);

    dispose();
    const released = new Event(type, { bubbles: true, cancelable: true });
    document.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
  },
);
