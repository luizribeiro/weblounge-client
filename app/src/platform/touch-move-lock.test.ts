import { afterEach, describe, expect, it } from "vitest";
import {
  claimHorizontalTouchMove,
  observeTouchMoveLock,
  shouldLockTouchMove,
} from "./touch-move-lock";

afterEach(() => document.body.replaceChildren());

describe("touch move lock", () => {
  it("cancels the touchmove after a horizontal gesture claims it", () => {
    const { root, target } = surfaces();
    const stop = observeTouchMoveLock(root, window);
    target.dispatchEvent(touchEvent("touchstart", target, 10, 20));
    const release = claimHorizontalTouchMove(root);
    const move = touchEvent("touchmove", target, 70, 50);

    target.dispatchEvent(move);

    expect(move.defaultPrevented).toBe(true);
    release();
    stop();
  });

  it("locks a vertical drag that starts on non-scrolling chrome", () => {
    const { root, target } = surfaces();
    expect(decide(root, target, 2, 40)).toBe(true);
  });

  it("uses the start target rather than a later target", () => {
    const { root, target, scroller } = surfaces();
    setScrollGeometry(scroller, 100, 500, 100);
    expect(decide(root, target, 0, -40)).toBe(true);
    expect(decide(root, scroller, 0, -40)).toBe(false);
  });

  it("allows an inner scroller only while it can move that way", () => {
    const { root, scroller } = surfaces();
    setScrollGeometry(scroller, 100, 500, 100);
    expect(decide(root, scroller, 0, 40)).toBe(false);
    expect(decide(root, scroller, 0, -40)).toBe(false);

    setScrollGeometry(scroller, 0, 500, 100);
    expect(decide(root, scroller, 0, 40)).toBe(true);
    setScrollGeometry(scroller, 400, 500, 100);
    expect(decide(root, scroller, 0, -40)).toBe(true);
  });

  it("exempts textarea and active selection gestures", () => {
    const { root } = surfaces();
    const textarea = document.createElement("textarea");
    root.append(textarea);
    expect(decide(root, textarea, 0, 40)).toBe(false);
    expect(decide(root, root, 0, 40, true, true)).toBe(false);
  });

  it("allows horizontal drags and all moves while the keyboard is closed", () => {
    const { root, target } = surfaces();
    expect(decide(root, target, 40, 10)).toBe(false);
    expect(decide(root, target, 0, 40, false, false)).toBe(false);
  });
});

function touchEvent(
  type: "touchstart" | "touchmove",
  target: Element,
  clientX: number,
  clientY: number,
): TouchEvent {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as TouchEvent;
  const touch = {
    clientX,
    clientY,
    identifier: 1,
    target,
  } as unknown as Touch;
  Object.defineProperty(event, "touches", { value: [touch] });
  return event;
}

function surfaces() {
  const root = document.createElement("main");
  const target = document.createElement("header");
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  root.append(target, scroller);
  document.body.append(root);
  return { root, scroller, target };
}

function decide(
  root: HTMLElement,
  target: Element,
  deltaX: number,
  deltaY: number,
  keyboardOpen = true,
  selectionActive = false,
) {
  return shouldLockTouchMove({
    browserWindow: window,
    deltaX,
    deltaY,
    keyboardOpen,
    root,
    selectionActive,
    startTarget: target,
  });
}

function setScrollGeometry(
  element: HTMLElement,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): void {
  element.scrollTop = scrollTop;
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
}
