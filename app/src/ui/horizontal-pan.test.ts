import { expect, it, vi } from "vitest";
import { createHorizontalPan, panCommits } from "./horizontal-pan";

it("axis-locks horizontal motion and commits by distance", () => {
  const progress = vi.fn();
  const commit = vi.fn();
  const cancel = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.4,
    commitVelocity: 0.5,
    direction: "right",
    onCancel: cancel,
    onCommit: commit,
    onProgress: progress,
  });

  gesture.begin(pointer(7, 100, 100, 0), 300);
  gesture.move(pointer(7, 106, 104, 20));
  expect(progress).toHaveBeenLastCalledWith(0);
  gesture.move(pointer(7, 220, 104, 400));
  expect(progress).toHaveBeenLastCalledWith(0.4);
  gesture.end(pointer(7, 220, 104, 500));

  expect(commit).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  expect(gesture.active()).toBe(false);
});

it("yields vertical motion and supports mirrored pans", () => {
  const cancel = vi.fn();
  const progress = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.4,
    commitVelocity: 0.5,
    direction: "left",
    onCancel: cancel,
    onCommit: vi.fn(),
    onProgress: progress,
  });

  gesture.begin(pointer(3, 200, 100, 0), 300);
  gesture.move(pointer(3, 195, 130, 100));
  expect(cancel).toHaveBeenCalledOnce();
  expect(gesture.active()).toBe(false);

  gesture.begin(pointer(4, 200, 100, 200), 300);
  gesture.move(pointer(4, 170, 100, 300));
  expect(progress).toHaveBeenLastCalledWith(0.1);
});

it("reports the release velocity from the last 100ms of motion", () => {
  const commit = vi.fn();
  const cancel = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.5,
    direction: "right",
    onCancel: cancel,
    onCommit: commit,
    onProgress: vi.fn(),
  });

  gesture.begin(pointer(1, 0, 100, 0), 400);
  gesture.move(pointer(1, 200, 100, 1_000));
  gesture.move(pointer(1, 240, 100, 1_050));
  gesture.move(pointer(1, 300, 100, 1_100));
  gesture.end(pointer(1, 300, 100, 1_100));
  expect(commit).toHaveBeenCalledWith({ velocity: 1 });

  gesture.begin(pointer(2, 0, 100, 2_000), 400);
  gesture.move(pointer(2, 150, 100, 2_100));
  gesture.move(pointer(2, 120, 100, 2_500));
  gesture.end(pointer(2, 100, 100, 2_550));
  expect(cancel).toHaveBeenCalledWith({ velocity: -0.4 });

  gesture.begin(pointer(3, 0, 100, 3_000), 400);
  gesture.move(pointer(3, 5, 100, 3_000));
  gesture.end(pointer(3, 5, 100, 3_000));
  expect(cancel).toHaveBeenLastCalledWith({ velocity: 0 });
});

it("uses distance or forward velocity, never zero distance", () => {
  expect(panCommits(119, 300, 0.2, 0.4, 0.5)).toBe(false);
  expect(panCommits(120, 300, 0.2, 0.4, 0.5)).toBe(true);
  expect(panCommits(40, 300, 0.5, 0.4, 0.5)).toBe(true);
  expect(panCommits(0, 300, 1, 0.4, 0.5)).toBe(false);
});

function pointer(
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
): PointerEvent {
  return {
    clientX,
    clientY,
    currentTarget: null,
    pointerId,
    preventDefault: vi.fn(),
    timeStamp,
  } as unknown as PointerEvent;
}
