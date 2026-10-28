import { describe, expect, it } from "vitest";
import {
  createMobileStack,
  finishTransition,
  mountedScreens,
  popChat,
  pushChat,
  swipeBackCompletes,
} from "./mobile-navigation";

describe("mobile stack navigation", () => {
  it("keeps only the active screen and one transition neighbour", () => {
    const pushed = pushChat(createMobileStack(), 7, false);

    expect(pushed.transition).toMatchObject({
      direction: "push",
      duration: 280,
    });
    expect(mountedScreens(pushed)).toHaveLength(2);
    expect(mountedScreens(finishTransition(pushed))).toEqual([
      { kind: "chat", bufferId: 7 },
    ]);

    const popped = popChat(finishTransition(pushed), false);
    expect(popped.transition).toMatchObject({
      direction: "pop",
      duration: 230,
    });
    expect(finishTransition(popped).active).toEqual({ kind: "chats" });
  });

  it("commits pushes and pops immediately under reduced motion", () => {
    const pushed = pushChat(createMobileStack(), 8, true);
    expect(pushed).toEqual({ active: { kind: "chat", bufferId: 8 } });
    expect(popChat(pushed, true)).toEqual({ active: { kind: "chats" } });
  });

  it("completes swipe-back by position or forward velocity", () => {
    expect(swipeBackCompletes(201, 402, 0)).toBe(true);
    expect(swipeBackCompletes(80, 402, 0.6)).toBe(true);
    expect(swipeBackCompletes(80, 402, 0.2)).toBe(false);
    expect(swipeBackCompletes(-20, 402, 1)).toBe(false);
  });
});
