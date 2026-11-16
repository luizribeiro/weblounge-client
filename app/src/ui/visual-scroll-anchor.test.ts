import { expect, it } from "vitest";
import type { FrameScheduler } from "./scroll-intent";
import {
  preserveVisualScrollAnchor,
  settleRowAnchor,
} from "./visual-scroll-anchor";

it("preserves a partially visible row through a virtualizer remeasure", () => {
  const scroller = document.createElement("div");
  const anchor = document.createElement("div");
  anchor.dataset.rowKey = "message-12";
  scroller.append(anchor);
  let rowTop = 71;
  scroller.scrollTop = 100;
  scroller.getBoundingClientRect = () => rect(0, 200);
  anchor.getBoundingClientRect = () => rect(rowTop - scroller.scrollTop, 40);

  preserveVisualScrollAnchor(scroller, () => {
    rowTop += 14;
  });

  expect(scroller.scrollTop).toBe(114);
  expect(anchor.getBoundingClientRect().top).toBe(-29);
});

it("settles a row back to its offset as late measurements land", () => {
  const view = transcript(236);
  view.row.top = 240.25;

  settle(view, -4);
  view.frames.run();
  expect(view.scroller.scrollTop).toBe(244);
  view.row.top = 262.25;
  view.frames.run();

  expect(view.scroller.scrollTop).toBe(266);
  expect(view.frames.runUntilIdle()).toBe(2);
});

it("stops when the remaining offset is smaller than a scroll step", () => {
  const view = transcript(174);
  view.row.top = 170.28125;

  settle(view, -4);

  expect(view.frames.runUntilIdle()).toBe(2);
  expect(view.scroller.scrollTop).toBe(174);
});

it("stops when the offset is past the scroller's range", () => {
  const view = transcript(0);
  view.row.top = 30;

  settle(view, 80);

  expect(view.frames.runUntilIdle()).toBe(2);
  expect(view.scroller.scrollTop).toBe(0);
});

it("keeps correcting while the scroller settles rows measured late", () => {
  const view = transcript(0);
  view.row.top = 500;
  view.state.settling = true;

  settle(view, 0);
  for (let frame = 0; frame < 5; frame += 1) view.frames.run();
  expect(view.scroller.scrollTop).toBe(400);
  view.state.maxScrollTop = 600;
  view.frames.run();
  view.state.settling = false;

  expect(view.scroller.scrollTop).toBe(500);
  expect(view.frames.runUntilIdle()).toBe(2);
});

it("stops when the anchored row is no longer rendered", () => {
  const view = transcript(100);
  view.row.element.remove();

  settle(view, -4);

  expect(view.frames.runUntilIdle()).toBe(1);
  expect(view.scroller.scrollTop).toBe(100);
});

it("cancels a correction before its first frame", () => {
  const view = transcript(100);
  view.row.top = 140;

  settle(view, 0)();

  expect(view.frames.runUntilIdle()).toBe(0);
  expect(view.scroller.scrollTop).toBe(100);
});

it("cancels a correction between frames", () => {
  const view = transcript(100);
  view.row.top = 140;
  const cancel = settle(view, 0);
  view.frames.run();
  view.row.top = 180;

  cancel();

  expect(view.frames.runUntilIdle()).toBe(0);
  expect(view.scroller.scrollTop).toBe(140);
});

interface ManualFrames extends FrameScheduler {
  run(): void;
  runUntilIdle(): number;
}

interface Transcript {
  readonly scroller: HTMLElement;
  readonly row: { top: number; readonly element: HTMLElement };
  readonly state: { maxScrollTop: number; settling: boolean };
  readonly frames: ManualFrames;
}

function settle(view: Transcript, top: number): () => void {
  return settleRowAnchor(
    view.scroller,
    { key: "message-3", top },
    view.frames,
    () => view.state.settling,
  );
}

/** A scroller that, like a browser at 1x, moves in whole pixels within its range. */
function transcript(scrollTop: number): Transcript {
  const state = { maxScrollTop: 400, settling: false };
  let position = scrollTop;
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "scrollTop", {
    get: () => position,
    set: (value: number) => {
      position = Math.min(Math.max(Math.round(value), 0), state.maxScrollTop);
    },
  });
  scroller.getBoundingClientRect = () => rect(0, 600);
  const element = document.createElement("li");
  element.dataset.rowKey = "message-3";
  scroller.append(element);
  const row = { top: 0, element };
  element.getBoundingClientRect = () => rect(row.top - position, 120);
  return { scroller, row, state, frames: manualFrames() };
}

function manualFrames(): ManualFrames {
  let queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  const run = () => {
    const due = queued;
    queued = new Map();
    for (const callback of due.values()) callback(0);
  };
  return {
    request: (callback) => {
      next += 1;
      queued.set(next, callback);
      return next;
    },
    cancel: (handle) => {
      queued.delete(handle);
    },
    run,
    runUntilIdle: () => {
      let count = 0;
      while (queued.size > 0 && count < 100) {
        run();
        count += 1;
      }
      return count;
    },
  };
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    top,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
