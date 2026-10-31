import { describe, expect, it } from "vitest";
import { createMobileStack, popChat, pushChat } from "./mobile-navigation";
import { pushOffset, settlesByTransition, stackMotion } from "./push-motion";

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
