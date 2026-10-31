import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeyboardMotionController,
  openingTranslate,
  readTranslateY,
  selectKeyboardMotion,
} from "./keyboard-motion";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("keyboard motion policy", () => {
  it("selects the native curve and duration", () => {
    expect(
      selectKeyboardMotion(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)",
        false,
      ),
    ).toMatchObject({ duration: 383, platform: "ios" });
    expect(
      selectKeyboardMotion(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)",
        false,
      ),
    ).toEqual({
      duration: 500,
      easing: "cubic-bezier(0.38, 0.7, 0.125, 1)",
      platform: "ios",
    });
    expect(selectKeyboardMotion("Android", true)).toEqual({
      duration: 285,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      platform: "android",
    });
  });

  it("retargets from the current transform after the layout step", () => {
    expect(
      openingTranslate(120, {
        afterHeight: 470,
        beforeHeight: 500,
        viewportOffsetTop: 0,
      }),
    ).toBe(150);
  });

  it("never adds app motion on top of a visual viewport pan", () => {
    expect(
      openingTranslate(120, {
        afterHeight: 470,
        beforeHeight: 500,
        viewportOffsetTop: 20,
      }),
    ).toBe(0);
  });

  it("reads current two- and three-dimensional transforms", () => {
    const surface = document.createElement("div");
    document.body.append(surface);
    surface.style.transform = "matrix(1, 0, 0, 1, 0, 42)";
    expect(readTranslateY(surface, window)).toBe(42);
    surface.style.transform =
      "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 73, 0, 1)";
    expect(readTranslateY(surface, window)).toBe(73);
  });
});

it("waits for both close motion and closed geometry before committing", async () => {
  const surface = document.createElement("div");
  surface.dataset.keyboardMotion = "true";
  document.body.append(surface);
  let finishAnimation = () => {};
  const finished = new Promise<void>((resolve) => {
    finishAnimation = resolve;
  });
  const cancel = vi.fn();
  surface.animate = vi.fn().mockReturnValue({ cancel, finished });
  const commit = vi.fn();
  const controller = new KeyboardMotionController(
    window,
    selectKeyboardMotion("iPhone OS 18_0", false),
    () => false,
  );

  controller.beginClose(358, commit);
  controller.closeGeometry(commit);
  expect(commit).not.toHaveBeenCalled();
  finishAnimation();
  await finished;
  await Promise.resolve();

  expect(commit).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
