import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeyboardMotionController,
  openingTarget,
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
    ).toMatchObject({ duration: 333, platform: "ios" });
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

  it("moves open surfaces by the layout-height difference", () => {
    expect(
      openingTarget({
        afterHeight: 470,
        beforeHeight: 800,
        viewportOffsetTop: 0,
      }),
    ).toBe(-330);
  });

  it("never adds app motion on top of a visual viewport pan", () => {
    expect(
      openingTarget({
        afterHeight: 470,
        beforeHeight: 800,
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

it("commits closed layout when motion ends without waiting for geometry", async () => {
  const { animations, finish, scope, scroller } = motionFixture();
  const commit = vi.fn();
  const controller = controllerFor(window);

  controller.beginClose(358, () => {}, commit);
  expect(commit).not.toHaveBeenCalled();
  expect(animations).toHaveLength(2);
  expect(animations[0]?.frames).toEqual([
    { transform: "translateY(0px)" },
    { transform: "translateY(358px)" },
  ]);
  expect(animations[1]?.frames).toEqual([
    { transform: "translateY(0px)" },
    { transform: "translateY(358px)" },
  ]);
  expect(scroller.scrollTop).toBe(73);

  finish();
  await Promise.resolve();
  await Promise.resolve();

  expect(commit).toHaveBeenCalledOnce();
  expect(scope.dataset.keyboardMotionActive).toBeUndefined();
});

it("settles an interrupted close back to the open position", () => {
  const { animations, scope } = motionFixture();
  const commit = vi.fn();
  const controller = controllerFor(window);

  controller.beginClose(358, () => {}, commit);
  controller.keepOpen();

  expect(animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(
    true,
  );
  expect(commit).not.toHaveBeenCalled();
  expect(scope.dataset.keyboardMotionActive).toBeUndefined();
});

it("retargets both surfaces from the current compositor transform", () => {
  const { animations, composer } = motionFixture();
  let reads = 0;
  vi.spyOn(composer, "getBoundingClientRect").mockImplementation(() =>
    rect(reads++ === 0 ? -120 : 0),
  );
  const controller = controllerFor(window);

  controller.open(
    { afterHeight: 400, beforeHeight: 800, viewportOffsetTop: 0 },
    () => {},
    () => {},
  );

  expect(animations).toHaveLength(2);
  expect(animations[0]?.frames).toEqual([
    { transform: "translateY(0px)" },
    { transform: "translateY(-280px)" },
  ]);
  expect(animations[1]?.frames).toEqual([
    { transform: "translateY(-120px)" },
    { transform: "translateY(-400px)" },
  ]);
});

interface RecordedAnimation {
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly frames: Keyframe[];
}

function motionFixture() {
  const scope = document.createElement("div");
  scope.dataset.keyboardMotion = "true";
  const content = document.createElement("div");
  content.dataset.keyboardMotionSurface = "true";
  const scroller = document.createElement("div");
  scroller.dataset.messageList = "true";
  scroller.scrollTop = 73;
  const composer = document.createElement("div");
  composer.dataset.composer = "true";
  composer.dataset.keyboardMotionSurface = "true";
  scope.append(scroller, content, composer);
  document.body.append(scope);
  let resolve = () => {};
  const finished = new Promise<void>((next) => {
    resolve = next;
  });
  const animations: RecordedAnimation[] = [];
  for (const surface of [content, composer])
    surface.animate = vi.fn().mockImplementation((frames: Keyframe[]) => {
      const animation = { cancel: vi.fn(), finished, frames };
      animations.push(animation);
      return animation;
    });
  return { animations, composer, finish: resolve, scope, scroller };
}

function controllerFor(browserWindow: Window): KeyboardMotionController {
  return new KeyboardMotionController(
    browserWindow,
    selectKeyboardMotion("iPhone OS 18_0", false),
    () => false,
  );
}

function rect(top: number): DOMRect {
  return {
    bottom: top,
    height: 0,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
