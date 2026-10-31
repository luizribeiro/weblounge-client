import { afterEach, expect, it, vi } from "vitest";
import {
  formatKeyboardTrace,
  installKeyboardDebug,
  readKeyboardTraceFrame,
} from "./keyboard-debug";

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
});

it("traces for one second after a tap or focusout and removes its listeners", () => {
  const root = document.createElement("div");
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
  callback?.(500);
  callback?.(1001);
  const overlay = document.querySelector<HTMLElement>("[data-debug-overlay]");
  expect(overlay?.textContent).toContain("trigger: pointerup");
  expect(overlay?.textContent).toContain("trace: ms sy vo vh ih rt rh ct");

  window.dispatchEvent(new FocusEvent("focusout"));
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
