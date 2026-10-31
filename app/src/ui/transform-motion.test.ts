import { afterEach, expect, it, vi } from "vitest";
import { afterStartStatePaints, movingTransform } from "./transform-motion";

afterEach(() => vi.unstubAllGlobals());

function withAnimations(animations: readonly Partial<CSSTransition>[]) {
  const element = document.createElement("div");
  element.getAnimations = () => animations as Animation[];
  return element;
}

it("runs after the second animation frame and can be cancelled", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const callback = vi.fn();
  afterStartStatePaints(callback);
  frames.shift()?.(0);
  expect(callback).not.toHaveBeenCalled();
  frames.shift()?.(16);
  expect(callback).toHaveBeenCalledOnce();

  const cancel = afterStartStatePaints(callback);
  cancel();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
});

it("reports only a running transform transition as moving", () => {
  expect(movingTransform(undefined)).toBe(false);
  expect(movingTransform(document.createElement("div"))).toBe(false);
  expect(
    movingTransform(
      withAnimations([{ playState: "running", transitionProperty: "opacity" }]),
    ),
  ).toBe(false);
  expect(
    movingTransform(
      withAnimations([
        { playState: "finished", transitionProperty: "transform" },
      ]),
    ),
  ).toBe(false);
  expect(
    movingTransform(
      withAnimations([
        { playState: "running", transitionProperty: "transform" },
      ]),
    ),
  ).toBe(true);
});
