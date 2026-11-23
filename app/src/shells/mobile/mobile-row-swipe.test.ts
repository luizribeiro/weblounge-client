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
    const start = beginMobileRowSwipe(300, 100, false);
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
    const start = beginMobileRowSwipe(300, 100, false);
    const dragged = moveMobileRowSwipe(start, 235, 102);
    expect(dragged).toMatchObject({ phase: "dragging", offset: 65 });
    expect(releaseMobileRowSwipe(dragged)).toBe("reveal");

    const flicked = moveMobileRowSwipe(start, 280, 100);
    expect(releaseMobileRowSwipe(flicked, -0.3)).toBe("reveal");
  });

  it("stops at the actions however far a swipe travels", () => {
    const start = beginMobileRowSwipe(390, 100, false);
    const full = moveMobileRowSwipe(start, 10, 100);
    expect(full).toMatchObject({
      phase: "dragging",
      offset: mobileRowActionWidth,
    });
    expect(releaseMobileRowSwipe(full)).toBe("reveal");
    expect(releaseMobileRowSwipe(full, -3)).toBe("reveal");
  });

  it("closes an open row that is swiped back to the right", () => {
    const back = moveMobileRowSwipe(
      beginMobileRowSwipe(150, 100, true),
      350,
      100,
    );
    expect(back).toMatchObject({ phase: "dragging", offset: 0 });
    expect(releaseMobileRowSwipe(back, 2)).toBe("reset");
  });

  it("returns cancellation to the endpoint where the gesture began", () => {
    const closed = beginMobileRowSwipe(300, 100, false);
    const revealed = beginMobileRowSwipe(300, 100, true);
    expect(cancelledMobileRowSwipe(moveMobileRowSwipe(closed, 250, 100))).toBe(
      "reset",
    );
    expect(
      cancelledMobileRowSwipe(moveMobileRowSwipe(revealed, 330, 100)),
    ).toBe("reveal");
    expect(revealed).toMatchObject({ offset: mobileRowActionWidth });
  });
});
