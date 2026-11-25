import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import type { ModifierChord } from "../../actions/action-registry";
import { createModifierHold } from "./modifier-hold";

const command: ModifierChord = {
  alt: false,
  ctrl: false,
  meta: true,
  shift: false,
};
const controlAlt: ModifierChord = {
  alt: true,
  ctrl: true,
  meta: false,
  shift: false,
};

let dispose = () => {};
afterEach(() => dispose());

function hold(
  chord: ModifierChord | undefined,
  keepsHold?: (event: KeyboardEvent) => boolean,
) {
  return createRoot((disposeRoot) => {
    dispose = disposeRoot;
    return createModifierHold(window, chord, keepsHold);
  });
}

function key(
  type: "keydown" | "keyup",
  keyValue: string,
  init: KeyboardEventInit = {},
): void {
  window.dispatchEvent(new KeyboardEvent(type, { key: keyValue, ...init }));
}

describe("modifier hold", () => {
  it("holds while only the jump modifier is down and releases on keyup", () => {
    const held = hold(command);
    key("keydown", "Meta", { metaKey: true });
    expect(held()).toBe(true);
    key("keyup", "Meta");
    expect(held()).toBe(false);
  });

  it("needs the whole chord before holding", () => {
    const held = hold(controlAlt);
    key("keydown", "Control", { ctrlKey: true });
    expect(held()).toBe(false);
    key("keydown", "Alt", { ctrlKey: true, altKey: true });
    expect(held()).toBe(true);
  });

  it("drops the hold when another key joins, and auto-repeat does not bring it back", () => {
    const held = hold(command);
    key("keydown", "Meta", { metaKey: true });
    key("keydown", "c", { metaKey: true });
    expect(held()).toBe(false);
    key("keydown", "Meta", { metaKey: true, repeat: true });
    expect(held()).toBe(false);
  });

  it("keeps the hold through keys that keep it, until the modifier is released", () => {
    const jumpDigit = (event: KeyboardEvent) => /^[1-9]$/u.test(event.key);
    const held = hold(command, jumpDigit);
    key("keydown", "Meta", { metaKey: true });
    key("keydown", "2", { metaKey: true });
    key("keyup", "2", { metaKey: true });
    key("keydown", "5", { metaKey: true });
    expect(held()).toBe(true);

    key("keydown", "k", { metaKey: true });
    expect(held()).toBe(false);
    key("keydown", "3", { metaKey: true });
    expect(held()).toBe(false);
    key("keyup", "Meta");
    expect(held()).toBe(false);

    key("keydown", "Meta", { metaKey: true });
    key("keydown", "4", { metaKey: true });
    key("keyup", "Meta");
    expect(held()).toBe(false);
  });

  it("drops the hold when an extra modifier joins", () => {
    const held = hold(command);
    key("keydown", "Meta", { metaKey: true });
    key("keydown", "Shift", { metaKey: true, shiftKey: true });
    expect(held()).toBe(false);
  });

  it("never holds for AltGraph", () => {
    const held = hold(controlAlt);
    const event = new KeyboardEvent("keydown", {
      key: "Alt",
      ctrlKey: true,
      altKey: true,
    });
    Object.defineProperty(event, "getModifierState", {
      value: (modifier: string) => modifier === "AltGraph",
    });
    window.dispatchEvent(event);
    expect(held()).toBe(false);
  });

  it("releases on window blur and when the page is hidden", () => {
    const held = hold(command);
    key("keydown", "Meta", { metaKey: true });
    expect(held()).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(held()).toBe(false);

    key("keydown", "Meta", { metaKey: true });
    expect(held()).toBe(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(held()).toBe(false);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it.each([
    ["pointermove", () => new PointerEvent("pointermove")],
    ["pointerdown", () => new PointerEvent("pointerdown")],
    ["wheel", () => new WheelEvent("wheel")],
  ])(
    "releases a hold whose keyup it missed on a %s without the chord",
    (_, event) => {
      const held = hold(command);
      key("keydown", "Meta", { metaKey: true });
      expect(held()).toBe(true);
      window.dispatchEvent(event());
      expect(held()).toBe(false);
    },
  );

  it("releases a multi-key chord when a pointer event lacks one of its keys", () => {
    const held = hold(controlAlt);
    key("keydown", "Control", { ctrlKey: true });
    key("keydown", "Alt", { ctrlKey: true, altKey: true });
    window.dispatchEvent(
      new PointerEvent("pointermove", { ctrlKey: true, altKey: true }),
    );
    expect(held()).toBe(true);
    window.dispatchEvent(new PointerEvent("pointermove", { ctrlKey: true }));
    expect(held()).toBe(false);
  });

  it("keeps the hold through pointer events that still carry the chord", () => {
    const held = hold(command);
    key("keydown", "Meta", { metaKey: true });
    window.dispatchEvent(new PointerEvent("pointermove", { metaKey: true }));
    window.dispatchEvent(new WheelEvent("wheel", { metaKey: true }));
    expect(held()).toBe(true);
    window.dispatchEvent(
      new PointerEvent("pointermove", { metaKey: true, shiftKey: true }),
    );
    expect(held()).toBe(false);
  });

  it("never holds from a pointer event alone", () => {
    const held = hold(command);
    window.dispatchEvent(new PointerEvent("pointermove", { metaKey: true }));
    expect(held()).toBe(false);
  });

  it("stops listening once disposed", () => {
    const held = hold(command);
    dispose();
    key("keydown", "Meta", { metaKey: true });
    expect(held()).toBe(false);
  });

  it("stops resyncing from the pointer once disposed", () => {
    const held = hold(command);
    key("keydown", "Meta", { metaKey: true });
    dispose();
    window.dispatchEvent(new PointerEvent("pointermove"));
    window.dispatchEvent(new PointerEvent("pointerdown"));
    window.dispatchEvent(new WheelEvent("wheel"));
    expect(held()).toBe(true);
  });

  it("never holds without a jump binding", () => {
    const held = hold(undefined);
    key("keydown", "Meta", { metaKey: true });
    expect(held()).toBe(false);
  });
});
