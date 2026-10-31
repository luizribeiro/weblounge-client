import { describe, expect, it } from "vitest";
import { createMobileStack, popChat, pushChat } from "./mobile-navigation";
import {
  bezierStartSlope,
  milliseconds,
  pushOffset,
  releasedSwipe,
  settleDurationScale,
  settlesByTransition,
  stackMotion,
} from "./push-motion";

describe("mobile push motion", () => {
  it("enters off-screen, then opens once the start state painted", () => {
    const push = pushChat(createMobileStack(), 7, false).transition;
    if (push === undefined) throw new Error("push transition is missing");

    expect(stackMotion(push, false)).toEqual({ phase: "entering" });
    expect(pushOffset(stackMotion(push, false))).toBe(1);
    expect(stackMotion(push, true)).toEqual({ phase: "opening" });
    expect(pushOffset(stackMotion(push, true))).toBe(0);
  });

  it("closes a pop back to the off-screen offset", () => {
    const pushed = pushChat(createMobileStack(), 7, true);
    const pop = popChat(pushed, false).transition;
    if (pop === undefined) throw new Error("pop transition is missing");

    expect(stackMotion(pop, false)).toEqual({ phase: "closing" });
    expect(pushOffset({ phase: "closing" })).toBe(1);
  });

  it("follows the finger while dragging and settles from there", () => {
    expect(pushOffset({ phase: "dragging", progress: 0.37 })).toBe(0.37);
    expect(pushOffset({ phase: "returning" })).toBe(0);
    expect(pushOffset({ phase: "completing" })).toBe(1);
  });

  it("settles a flick sooner than a slow release, within bounds", () => {
    const slow = settleDurationScale(0.5, 0.0002);
    const flick = settleDurationScale(0.5, 0.0025);
    const fastest = settleDurationScale(0.5, 1);

    expect(slow).toBe(1.8);
    expect(flick).toBeGreaterThan(1.3);
    expect(flick).toBeLessThan(slow);
    expect(fastest).toBe(1.3);
    expect(settleDurationScale(0.5, 0)).toBe(1.8);
    expect(settleDurationScale(0.5, -0.004)).toBe(1.8);
    expect(settleDurationScale(0.5, Number.NaN)).toBe(1.8);
  });

  it("reads the settle timing from motion tokens strictly", () => {
    expect(bezierStartSlope("cubic-bezier(0.25, 0.46, 0.45, 0.94)")).toBe(1.84);
    expect(() => bezierStartSlope("cubic-bezier(0, 1, 0.4, 1)")).toThrow();
    expect(() => bezierStartSlope("ease-out")).toThrow();
    expect(milliseconds("230ms")).toBe(230);
    expect(() => milliseconds("0.23s")).toThrow();
  });

  it("measures the remaining travel toward the released target", () => {
    expect(releasedSwipe("completing", 0.6, 0.004)).toEqual({
      durationScale: settleDurationScale(0.4, 0.004),
      phase: "completing",
    });
    expect(releasedSwipe("returning", 0.3, -0.004)).toEqual({
      durationScale: settleDurationScale(0.3, 0.004),
      phase: "returning",
    });
    expect(releasedSwipe("returning", 0.3, 0.004).durationScale).toBe(1.8);
  });

  it("settles only phases that transition to a resting offset", () => {
    expect(settlesByTransition("entering")).toBe(false);
    expect(settlesByTransition("dragging")).toBe(false);
    for (const phase of [
      "opening",
      "closing",
      "returning",
      "completing",
    ] as const)
      expect(settlesByTransition(phase)).toBe(true);
  });
});
