import { expect, it, vi } from "vitest";
import { ScrollIntentTracker } from "./scroll-intent";

it("does not claim a layout scroll after pointer hover", () => {
  const frames = new ControlledFrames();
  const tracker = new ScrollIntentTracker(() => 0, frames);

  expect(tracker.consumeScroll()).toBe(false);
});

it("owns a browser-cancelled touch pan and its momentum until settling", () => {
  let offset = 20;
  const frames = new ControlledFrames();
  const tracker = new ScrollIntentTracker(() => offset, frames);

  tracker.beginPointer();
  tracker.beginTouch();
  tracker.cancelPointer();
  offset = 30;
  expect(tracker.consumeScroll()).toBe(true);
  offset = 40;
  expect(tracker.consumeScroll()).toBe(true);
  tracker.endTouch();
  offset = 55;
  expect(tracker.consumeScroll()).toBe(true);
  offset = 65;
  expect(tracker.consumeScroll()).toBe(true);
  frames.flush();
  frames.flush();
  offset = 50;
  expect(tracker.consumeScroll()).toBe(false);
});

it.each(["wheel", "key"])("owns a %s scroll", () => {
  const frames = new ControlledFrames();
  const tracker = new ScrollIntentTracker(() => 10, frames);

  tracker.beginDiscrete();
  expect(tracker.consumeScroll()).toBe(true);
});

it("expires wheel or key intent when no scroll follows", () => {
  const frames = new ControlledFrames();
  const tracker = new ScrollIntentTracker(() => 0, frames);

  tracker.beginDiscrete();
  frames.flush();
  frames.flush();
  expect(tracker.consumeScroll()).toBe(false);
});

it("ignores an idle layout change after a user scroll", () => {
  let offset = 100;
  const frames = new ControlledFrames();
  const tracker = new ScrollIntentTracker(() => offset, frames);

  tracker.beginDiscrete();
  expect(tracker.consumeScroll()).toBe(true);
  frames.flush();
  frames.flush();
  offset = 80;
  expect(tracker.consumeScroll()).toBe(false);
});

class ControlledFrames {
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextHandle = 1;

  readonly request = vi.fn((callback: FrameRequestCallback) => {
    const handle = this.#nextHandle++;
    this.#callbacks.set(handle, callback);
    return handle;
  });

  readonly cancel = vi.fn((handle: number) => {
    this.#callbacks.delete(handle);
  });

  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(0);
  }
}
