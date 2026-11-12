import { describe, expect, it } from "vitest";
import {
  beginMobileRowSwipe,
  cancelledMobileRowSwipe,
  mobileRowActionWidth,
  moveMobileRowSwipe,
  releaseMobileRowSwipe,
} from "./mobile-row-swipe";

describe("mobile chat-row swipe", () => {
  it("waits for horizontal intent and does not hijack vertical scrolling", () => {
    const start = beginMobileRowSwipe("direct", 400, 300, 100, false);
    expect(moveMobileRowSwipe(start, 294, 106)).toEqual(start);
    expect(moveMobileRowSwipe(start, 296, 122)).toEqual({
      phase: "cancelled",
      revealed: false,
    });
    expect(moveMobileRowSwipe(start, 312, 100)).toEqual({
      phase: "cancelled",
      revealed: false,
    });
  });

  it("reveals actions after a deliberate drag or left flick", () => {
    const start = beginMobileRowSwipe("direct", 400, 300, 100, false);
    const dragged = moveMobileRowSwipe(start, 235, 102);
    expect(dragged).toMatchObject({ phase: "dragging", offset: 65 });
    expect(releaseMobileRowSwipe(dragged)).toBe("reveal");

    const flicked = moveMobileRowSwipe(start, 280, 100);
    expect(releaseMobileRowSwipe(flicked, -0.3)).toBe("reveal");
  });

  it("closes only a direct conversation after a sixty-percent swipe", () => {
    const direct = moveMobileRowSwipe(
      beginMobileRowSwipe("direct", 400, 300, 100, false),
      60,
      100,
    );
    const channel = moveMobileRowSwipe(
      beginMobileRowSwipe("channel", 400, 300, 100, false),
      60,
      100,
    );
    expect(releaseMobileRowSwipe(direct)).toBe("close");
    expect(releaseMobileRowSwipe(channel)).toBe("reveal");
  });

  it("returns cancellation to the endpoint where the gesture began", () => {
    const closed = beginMobileRowSwipe("direct", 400, 300, 100, false);
    const revealed = beginMobileRowSwipe("direct", 400, 300, 100, true);
    expect(cancelledMobileRowSwipe(moveMobileRowSwipe(closed, 250, 100))).toBe(
      "reset",
    );
    expect(
      cancelledMobileRowSwipe(moveMobileRowSwipe(revealed, 330, 100)),
    ).toBe("reveal");
    expect(revealed).toMatchObject({ offset: mobileRowActionWidth });
  });
});
