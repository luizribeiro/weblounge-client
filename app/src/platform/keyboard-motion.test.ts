import { afterEach, describe, expect, it, vi } from "vitest";
import { observeKeyboardMotion } from "./keyboard-motion";
import {
  keyboardLayoutCommitEvent,
  keyboardLayoutWillCommitEvent,
} from "./viewport-geometry";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("keyboard motion", () => {
  it("animates opening from a full-height transcript snapshot", async () => {
    const fixture = motionFixture();
    const stop = observeKeyboardMotion(fixture.root, window, { enabled: true });

    fixture.willOpen();
    fixture.setComposerBottom(516);
    fixture.didOpen();

    expect(fixture.composerAnimate).toHaveBeenCalledWith(
      [{ transform: "translateY(358px)" }, { transform: "none" }],
      expect.objectContaining({
        delay: -20,
        duration: 400,
        easing: expect.stringMatching(/^linear\(/u),
        fill: "both",
      }),
    );
    expect(fixture.transcriptAnimate).toHaveBeenCalledWith(
      [{ transform: "none" }, { transform: "translateY(-358px)" }],
      expect.any(Object),
    );
    expect(fixture.root.dataset.keyboardMotion).toBe("opening");
    expect(
      fixture.root.querySelector("[data-keyboard-transcript-snapshot]"),
    ).not.toBeNull();
    fixture.animations[1]?.finish();
    await Promise.resolve();
    expect(fixture.root.dataset.keyboardMotion).toBe("open");
    expect(
      fixture.root.querySelector("[data-keyboard-transcript-snapshot]"),
    ).toBeNull();
    stop();
  });

  it("uses the measured cubic fallback without linear easing", () => {
    vi.spyOn(CSS, "supports").mockReturnValue(false);
    const fixture = motionFixture();
    const stop = observeKeyboardMotion(fixture.root, window, { enabled: true });

    fixture.willOpen();
    fixture.setComposerBottom(516);
    fixture.didOpen();

    expect(fixture.composerAnimate).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        duration: 380,
        easing: "cubic-bezier(.285,.9,.285,1)",
      }),
    );
    stop();
  });

  it("snaps the transcript and animates only the closing composer", () => {
    const fixture = motionFixture();
    fixture.setComposerBottom(516);
    const stop = observeKeyboardMotion(fixture.root, window, { enabled: true });

    fixture.willClose();
    fixture.setComposerBottom(874);
    fixture.didClose();

    expect(fixture.composerAnimate).toHaveBeenCalledWith(
      [{ transform: "translateY(-358px)" }, { transform: "none" }],
      expect.objectContaining({ delay: -20, fill: "both" }),
    );
    expect(fixture.transcriptAnimate).not.toHaveBeenCalled();
    stop();
  });

  it("reverses a close after two frames without viewport growth", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const fixture = motionFixture();
    fixture.setComposerBottom(516);
    const stop = observeKeyboardMotion(fixture.root, window, { enabled: true });

    fixture.willClose();
    fixture.setComposerBottom(874);
    fixture.didClose();
    frames.shift()?.(0);
    frames.shift()?.(16);

    expect(fixture.animations[0]?.reverse).toHaveBeenCalledOnce();
    stop();
  });

  it("continues a reversed close when viewport growth arrives later", () => {
    const previousViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const viewport = new EventTarget();
    let viewportHeight = 516;
    Object.defineProperties(viewport, {
      height: { get: () => viewportHeight },
      offsetTop: { value: 0 },
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const fixture = motionFixture();
    fixture.setComposerBottom(516);
    const stop = observeKeyboardMotion(fixture.root, window, { enabled: true });

    try {
      fixture.willClose();
      fixture.setComposerBottom(874);
      fixture.didClose();
      frames.shift()?.(0);
      frames.shift()?.(16);
      viewportHeight = 874;
      viewport.dispatchEvent(new Event("resize"));

      expect(fixture.animations[0]?.reverse).toHaveBeenCalledTimes(2);
      expect(fixture.animations[0]?.animation.playbackRate).toBe(1);
    } finally {
      stop();
      restoreProperty(window, "visualViewport", previousViewport);
    }
  });

  it("corrects a closing composer that finishes more than one pixel short", async () => {
    const fixture = motionFixture();
    fixture.setComposerBottom(516);
    const stop = observeKeyboardMotion(fixture.root, window, { enabled: true });

    fixture.willClose();
    fixture.setComposerBottom(window.innerHeight - 3);
    fixture.didClose();
    fixture.animations[0]?.finish();
    await Promise.resolve();

    expect(fixture.composerAnimate).toHaveBeenLastCalledWith(
      [{ transform: "translateY(3px)" }, { transform: "none" }],
      expect.objectContaining({ duration: 100 }),
    );
    stop();
  });

  it.each([
    { enabled: false, reduced: false, reason: "kill switch" },
    { enabled: true, reduced: true, reason: "reduced motion" },
  ])("bypasses keyboard motion for $reason", ({ enabled, reduced }) => {
    const fixture = motionFixture();
    const stop = observeKeyboardMotion(fixture.root, window, {
      enabled,
      prefersReducedMotion: () => reduced,
    });

    fixture.willOpen();
    fixture.setComposerBottom(516);
    fixture.didOpen();
    fixture.willClose();
    fixture.setComposerBottom(874);
    fixture.didClose();

    expect(fixture.composerAnimate).not.toHaveBeenCalled();
    expect(fixture.transcriptAnimate).not.toHaveBeenCalled();
    stop();
  });
});

function motionFixture() {
  const root = document.createElement("div");
  root.dataset.shell = "mobile";
  const screen = document.createElement("section");
  screen.dataset.mobileChat = "1";
  const transcript = document.createElement("ol");
  transcript.dataset.messageMotionLayer = "true";
  const composer = document.createElement("div");
  composer.dataset.composer = "true";
  screen.append(transcript, composer);
  root.append(screen);
  document.body.append(root);
  let composerBottom = 874;
  composer.getBoundingClientRect = () =>
    ({
      bottom: composerBottom,
      height: 63,
      top: composerBottom - 63,
    }) as DOMRect;
  const animations: TestAnimation[] = [];
  const composerAnimate = vi.fn(() => {
    const testAnimation = fakeAnimation();
    animations.push(testAnimation);
    return testAnimation.animation;
  });
  const transcriptAnimate = vi.fn(() => {
    const testAnimation = fakeAnimation();
    animations.push(testAnimation);
    return testAnimation.animation;
  });
  composer.animate = composerAnimate;
  transcript.animate = transcriptAnimate;
  return {
    animations,
    composerAnimate,
    didClose() {
      window.dispatchEvent(
        new CustomEvent(keyboardLayoutCommitEvent, {
          detail: {
            geometry: { keyboard: "closed" },
            source: "rollback",
          },
        }),
      );
    },
    didOpen() {
      window.dispatchEvent(
        new CustomEvent(keyboardLayoutCommitEvent, {
          detail: {
            geometry: { keyboard: "open", height: 516 },
            source: "measured",
          },
        }),
      );
    },
    root,
    setComposerBottom(value: number) {
      composerBottom = value;
    },
    transcriptAnimate,
    willClose() {
      window.dispatchEvent(
        new CustomEvent(keyboardLayoutWillCommitEvent, {
          detail: {
            geometry: { keyboard: "closed" },
            owner: root,
            previousGeometry: { keyboard: "open", height: 516 },
            source: "rollback",
          },
        }),
      );
    },
    willOpen() {
      window.dispatchEvent(
        new CustomEvent(keyboardLayoutWillCommitEvent, {
          detail: {
            geometry: { keyboard: "open", height: 516 },
            owner: root,
            previousGeometry: { keyboard: "closed" },
            source: "measured",
          },
        }),
      );
    },
  };
}

interface TestAnimation {
  readonly animation: Animation;
  readonly finish: () => void;
  readonly reverse: ReturnType<typeof vi.fn>;
}

function fakeAnimation(): TestAnimation {
  const reverse = vi.fn();
  let finish: () => void = () => undefined;
  const animation = {
    cancel: vi.fn(),
    finished: new Promise<Animation>((resolve) => {
      finish = () => resolve(animation);
    }),
    playbackRate: 1,
    reverse,
  } as unknown as Animation;
  reverse.mockImplementation(() => {
    animation.playbackRate *= -1;
  });
  return { animation, finish, reverse };
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, property);
  else Object.defineProperty(target, property, descriptor);
}
