import { describe, expect, it } from "vitest";
import {
  createMobileStack,
  finishTransition,
  layeredScreens,
  popChat,
  previousScreen,
  pushChat,
  pushScreen,
  swipeBackCompletes,
} from "./mobile-navigation";

describe("mobile stack navigation", () => {
  it("layers the moving screen above the still one", () => {
    const pushed = pushChat(createMobileStack(), 7, false);

    expect(pushed.transition).toMatchObject({
      direction: "push",
      duration: 280,
    });
    expect(layeredScreens(pushed, false)).toEqual([
      { kind: "chats" },
      { kind: "chat", bufferId: 7 },
    ]);
    expect(layeredScreens(finishTransition(pushed), false)).toEqual([
      { kind: "chat", bufferId: 7 },
    ]);
    expect(layeredScreens(finishTransition(pushed), true)).toEqual([
      { kind: "chats" },
      { kind: "chat", bufferId: 7 },
    ]);

    const popped = popChat(finishTransition(pushed), false);
    expect(popped.transition).toMatchObject({
      direction: "pop",
      duration: 230,
    });
    expect(layeredScreens(popped, false)).toEqual([
      { kind: "chats" },
      { kind: "chat", bufferId: 7 },
    ]);
    expect(finishTransition(popped).active).toEqual({ kind: "chats" });
    expect(layeredScreens(createMobileStack(), true)).toEqual([
      { kind: "chats" },
    ]);
  });

  it("commits pushes and pops immediately under reduced motion", () => {
    const pushed = pushChat(createMobileStack(), 8, true);
    expect(pushed.active).toEqual({ kind: "chat", bufferId: 8 });
    expect(popChat(pushed, true).active).toEqual({ kind: "chats" });
  });

  it("pushes a member DM over its channel", () => {
    const channel = pushChat(createMobileStack(), 8, true);
    const direct = pushChat(channel, 9, true, true);
    expect(previousScreen(direct)).toEqual({ kind: "chat", bufferId: 8 });
    expect(popChat(direct, true).active).toEqual({ kind: "chat", bufferId: 8 });
  });

  it("uses claim-relative distance and release velocity for swipe-back", () => {
    expect(swipeBackCompletes(201, 402, 0)).toBe(false);
    expect(swipeBackCompletes(202, 402, 0)).toBe(true);
    expect(swipeBackCompletes(80, 402, 0.25)).toBe(true);
    expect(swipeBackCompletes(80, 402, 0.24)).toBe(false);
    expect(swipeBackCompletes(202, 402, -0.05)).toBe(true);
    expect(swipeBackCompletes(202, 402, -0.06)).toBe(false);
    expect(swipeBackCompletes(-20, 402, 1)).toBe(false);
  });

  it("stacks Settings pages over Chats and pops them one at a time", () => {
    const root = { kind: "settings", page: "root" } as const;
    const appearance = { kind: "settings", page: "appearance" } as const;
    const settings = pushScreen(createMobileStack(), root, true);
    const page = pushScreen(settings, appearance, false);

    expect(page).toEqual({
      active: appearance,
      back: [{ kind: "chats" }, root],
      transition: {
        direction: "push",
        from: root,
        to: appearance,
        duration: 280,
      },
    });
    const backToRoot = popChat(finishTransition(page), true);
    expect(backToRoot).toEqual({ active: root, back: [{ kind: "chats" }] });
    expect(popChat(backToRoot, true)).toEqual({
      active: { kind: "chats" },
      back: [],
    });
    expect(pushChat(finishTransition(page), 4, true)).toEqual({
      active: { kind: "chat", bufferId: 4 },
      back: [{ kind: "chats" }],
    });
  });
});
