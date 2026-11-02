import { afterEach, expect, it, vi } from "vitest";
import {
  formatKeyboardTrace,
  installKeyboardDebug,
  readKeyboardTraceFrame,
  reportKeyboardInteraction,
  summarizeKeyboardTrace,
} from "./keyboard-debug";
import {
  keyboardLayoutCommitEvent,
  keyboardRollbackDecisionEvent,
} from "./viewport-geometry";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("records the keyboard geometry needed for an on-device frame trace", () => {
  const root = document.createElement("div");
  const composer = document.createElement("div");
  composer.dataset.composer = "true";
  root.append(composer);
  document.body.append(root);
  vi.spyOn(root, "getBoundingClientRect").mockReturnValue(rect(8, 476));
  vi.spyOn(composer, "getBoundingClientRect").mockReturnValue(rect(410, 66));

  const frame = readKeyboardTraceFrame(window, root, 100, 116.7);

  expect(frame).toMatchObject({
    composerTop: 410,
    innerHeight: window.innerHeight,
    rootHeight: 476,
    rootTop: 8,
    scrollY: 0,
  });
  expect(frame.elapsed).toBeCloseTo(16.7);
  expect(formatKeyboardTrace([frame])).toContain(
    `${window.innerHeight} 8 476 410`,
  );
  expect(summarizeKeyboardTrace([frame])).toContain("1 frames · tap to copy");
});

it("traces taps and composer focusout but ignores unrelated focusout", () => {
  const root = document.createElement("div");
  const composer = document.createElement("div");
  composer.dataset.composer = "true";
  const field = document.createElement("textarea");
  const send = document.createElement("button");
  send.dataset.composerSend = "true";
  const unrelatedButton = document.createElement("button");
  composer.append(field, send);
  root.append(composer, unrelatedButton);
  document.body.append(root);
  let callback: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((next) => {
    callback = next;
    return 7;
  });
  vi.spyOn(window.performance, "now").mockReturnValue(0);
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const stop = installKeyboardDebug(root, window);

  window.dispatchEvent(new PointerEvent("pointerup", { isPrimary: true }));
  reportKeyboardInteraction("touchstart");
  reportKeyboardInteraction("touchend:tap");
  reportKeyboardInteraction("touchend:rejected(moved 14px)");
  field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  reportKeyboardInteraction("focus:landed");
  window.dispatchEvent(
    new CustomEvent(keyboardLayoutCommitEvent, {
      detail: {
        geometry: { keyboard: "closed" },
        rollbackReason: "focus-left-keyboard-field",
        source: "rollback",
      },
    }),
  );
  window.dispatchEvent(
    new CustomEvent(keyboardRollbackDecisionEvent, {
      detail: {
        outcome: "deferred",
        reason: "pointer-ended-without-focus",
      },
    }),
  );
  callback?.(500);
  callback?.(1001);
  const overlay = document.querySelector<HTMLElement>("[data-debug-overlay]");
  expect(overlay?.textContent).toContain("trigger: pointerup");
  expect(overlay?.textContent).toContain(
    "commits: rollback:closed(focus-left-keyboard-field)",
  );
  expect(overlay?.textContent).toContain(
    "rollbacks: deferred(pointer-ended-without-focus)",
  );
  expect(overlay?.textContent).toContain("touchstart");
  expect(overlay?.textContent).toContain("touchend:tap");
  expect(overlay?.textContent).toContain("touchend:rejected(moved 14px)");
  expect(overlay?.textContent).toContain("focusin:composer(no-pointer)");
  expect(overlay?.textContent).toContain("focus:landed");
  expect(overlay?.textContent).toContain("frames · tap to copy full trace");

  send.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  send.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  expect(overlay?.textContent).toContain("pointerdown:composer(send)");
  expect(overlay?.textContent).toContain("pointerup:composer(send)");

  unrelatedButton.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  expect(overlay?.textContent).toContain("trigger: pointerup");

  field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  expect(overlay?.textContent).toContain("trigger: focusout");
  stop();
  expect(cancel).toHaveBeenCalledWith(7);
  expect(document.querySelector("[data-debug-overlay]")).toBeNull();
});

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
