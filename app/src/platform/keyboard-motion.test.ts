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
  it("animates opening from the pre-commit composer position", () => {
    const fixture = motionFixture();
    const stop = observeKeyboardMotion(fixture.root, window);

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
      [{ transform: "translateY(358px)" }, { transform: "none" }],
      expect.any(Object),
    );
    stop();
  });

  it("uses the measured cubic fallback without linear easing", () => {
    vi.spyOn(CSS, "supports").mockReturnValue(false);
    const fixture = motionFixture();
    const stop = observeKeyboardMotion(fixture.root, window);

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

  it.each([
    { enabled: false, reduced: false, reason: "kill switch" },
    { enabled: true, reduced: true, reason: "reduced motion" },
  ])("bypasses opening for $reason", ({ enabled, reduced }) => {
    const fixture = motionFixture();
    const stop = observeKeyboardMotion(fixture.root, window, {
      enabled,
      prefersReducedMotion: () => reduced,
    });

    fixture.willOpen();
    fixture.setComposerBottom(516);
    fixture.didOpen();

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
    ({ bottom: composerBottom }) as DOMRect;
  const composerAnimate = vi.fn(() => fakeAnimation());
  const transcriptAnimate = vi.fn(() => fakeAnimation());
  composer.animate = composerAnimate;
  transcript.animate = transcriptAnimate;
  return {
    composerAnimate,
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

function fakeAnimation(): Animation {
  return {
    cancel: vi.fn(),
    finished: Promise.resolve(),
  } as unknown as Animation;
}
