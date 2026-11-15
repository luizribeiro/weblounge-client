import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLongPress,
  type LongPress,
  longPressMilliseconds,
} from "./long-press";

let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup() {
  const row = document.createElement("div");
  const link = document.createElement("a");
  link.href = "https://example.test/";
  link.textContent = "a link";
  row.append(link);
  document.body.append(row);
  const recognised = vi.fn();
  const press = createRoot((cleanup) => {
    dispose = cleanup;
    const longPress: LongPress = createLongPress(recognised);
    longPress.attach(row);
    return longPress;
  });
  return { link, press, recognised, row };
}

function pointer(
  target: Element,
  type: string,
  init: Partial<PointerEventInit> = {},
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: 100,
      clientY: 200,
      isPrimary: true,
      pointerId: 5,
      pointerType: "touch",
      ...init,
    }),
  );
}

function click(target: Element): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    detail: 1,
  });
  target.dispatchEvent(event);
  return event;
}

it("recognises a still touch held for the long-press window", () => {
  const { press, recognised, row } = setup();

  pointer(row, "pointerdown");
  expect(press.pressing()).toBe(true);
  vi.advanceTimersByTime(longPressMilliseconds - 1);
  expect(recognised).not.toHaveBeenCalled();
  pointer(row, "pointermove", { clientX: 106, clientY: 206 });
  vi.advanceTimersByTime(1);

  expect(recognised).toHaveBeenCalledOnce();
  expect(press.pressing()).toBe(false);
});

it("abandons the press when the finger moves, lifts, or the browser takes the pan", () => {
  const { press, recognised, row } = setup();

  pointer(row, "pointerdown");
  pointer(row, "pointermove", { clientY: 230 });
  expect(press.pressing()).toBe(false);
  pointer(row, "pointerdown");
  pointer(row, "pointerup");
  pointer(row, "pointerdown");
  pointer(row, "pointercancel");
  vi.advanceTimersByTime(longPressMilliseconds * 2);

  expect(recognised).not.toHaveBeenCalled();
  expect(press.pressing()).toBe(false);
});

it("swallows only the click that ends a recognised press", () => {
  const { link, recognised, row } = setup();

  pointer(link, "pointerdown");
  vi.advanceTimersByTime(longPressMilliseconds);
  pointer(link, "pointerup");
  const keyboardClick = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(keyboardClick);
  expect(keyboardClick.defaultPrevented).toBe(false);
  expect(click(link).defaultPrevented).toBe(true);
  expect(click(link).defaultPrevented).toBe(false);

  pointer(row, "pointerdown");
  pointer(row, "pointerup");
  expect(click(link).defaultPrevented).toBe(false);
  expect(recognised).toHaveBeenCalledOnce();
});

it("opens once from a context menu, including the platform's own after a held touch", () => {
  const { recognised, row } = setup();
  const contextMenu = () => {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(event);
    return event.defaultPrevented;
  };

  pointer(row, "pointerdown");
  vi.advanceTimersByTime(longPressMilliseconds);
  expect(contextMenu()).toBe(true);
  expect(recognised).toHaveBeenCalledOnce();

  pointer(row, "pointerdown", { pointerType: "mouse" });
  expect(contextMenu()).toBe(true);
  expect(recognised).toHaveBeenCalledTimes(2);
});

it("leaves mouse presses, secondary touches and live selections alone", () => {
  const { press, recognised, link, row } = setup();

  pointer(row, "pointerdown", { pointerType: "mouse" });
  pointer(row, "pointerdown", { isPrimary: false });
  expect(press.pressing()).toBe(false);
  const range = document.createRange();
  range.selectNodeContents(link);
  window.getSelection()?.addRange(range);
  pointer(row, "pointerdown");
  vi.advanceTimersByTime(longPressMilliseconds);

  expect(press.pressing()).toBe(false);
  expect(recognised).not.toHaveBeenCalled();
});

it("abandons a press when the page is hidden", () => {
  const { press, recognised, row } = setup();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");

  pointer(row, "pointerdown");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(longPressMilliseconds);
  visibility.mockRestore();

  expect(press.pressing()).toBe(false);
  expect(recognised).not.toHaveBeenCalled();
});
