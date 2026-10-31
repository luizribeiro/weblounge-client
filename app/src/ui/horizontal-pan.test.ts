import { expect, it, vi } from "vitest";
import { createHorizontalPan, panCommits } from "./horizontal-pan";

it("claims a horizontal pan without jumping past its lock threshold", () => {
  const progress = vi.fn();
  const commit = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.3,
    commitVelocity: 0.25,
    direction: "right",
    onCancel: vi.fn(),
    onCommit: commit,
    onProgress: progress,
  });

  gesture.begin(pointer(7, 100, 100, 0), 300);
  gesture.move(pointer(7, 106, 104, 20));
  expect(progress).not.toHaveBeenCalled();
  gesture.move(pointer(7, 115, 104, 100));
  expect(progress).toHaveBeenLastCalledWith(0);
  gesture.move(pointer(7, 215, 104, 400));
  expect(progress).toHaveBeenLastCalledWith(1 / 3);
  gesture.end(pointer(7, 215, 104, 500));

  expect(commit).toHaveBeenCalledOnce();
  expect(gesture.active()).toBe(false);
});

it("yields vertical and opposite-direction motion", () => {
  const cancel = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.4,
    commitVelocity: 0.25,
    direction: "left",
    onCancel: cancel,
    onCommit: vi.fn(),
    onProgress: vi.fn(),
  });

  gesture.begin(pointer(3, 200, 100, 0), 300);
  gesture.move(pointer(3, 195, 130, 100));
  expect(cancel).toHaveBeenCalledOnce();

  gesture.begin(pointer(4, 200, 100, 200), 300);
  gesture.move(pointer(4, 230, 100, 300));
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(gesture.active()).toBe(false);
});

it("commits a slow drag followed by a release flick", () => {
  const commit = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.25,
    direction: "right",
    onCancel: vi.fn(),
    onCommit: commit,
    onProgress: vi.fn(),
  });

  gesture.begin(pointer(1, 0, 100, 0), 400);
  gesture.move(pointer(1, 20, 100, 10));
  gesture.move(pointer(1, 100, 100, 1_000));
  gesture.move(pointer(1, 140, 100, 1_050));
  gesture.end(pointer(1, 200, 100, 1_100));

  expect(commit).toHaveBeenCalledWith({
    averageVelocity: 180 / 1_090,
    distance: 180,
    progressPerMs: 0.0025,
    releaseVelocity: 1,
  });
});

it("cancels a backward release after passing halfway", () => {
  const cancel = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.25,
    direction: "right",
    onCancel: cancel,
    onCommit: vi.fn(),
    onProgress: vi.fn(),
  });

  gesture.begin(pointer(2, 0, 100, 0), 300);
  gesture.move(pointer(2, 20, 100, 10));
  gesture.move(pointer(2, 210, 100, 200));
  gesture.move(pointer(2, 180, 100, 250));
  gesture.end(pointer(2, 170, 100, 300));

  expect(cancel).toHaveBeenCalledWith(
    expect.objectContaining({ distance: 150, releaseVelocity: -0.4 }),
  );
});

it("treats pointer cancellation after claim as a release", () => {
  const commit = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.25,
    direction: "right",
    onCancel: vi.fn(),
    onCommit: commit,
    onProgress: vi.fn(),
  });

  gesture.begin(pointer(5, 0, 100, 0), 300);
  gesture.move(pointer(5, 20, 100, 10));
  gesture.move(pointer(5, 190, 180, 200));
  gesture.cancel(pointer(5, 190, 180, 210));

  expect(commit).toHaveBeenCalledOnce();
  expect(gesture.active()).toBe(false);
});

it("settles from the last movement when pointer capture is lost", () => {
  const cancel = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.25,
    direction: "right",
    onCancel: cancel,
    onCommit: vi.fn(),
    onProgress: vi.fn(),
  });

  gesture.begin(pointer(6, 0, 100, 0), 300);
  gesture.move(pointer(6, 20, 100, 10));
  gesture.move(pointer(6, 80, 100, 500));
  gesture.lostCapture(pointer(6, 0, 0, 900));

  expect(cancel).toHaveBeenCalledWith(
    expect.objectContaining({ distance: 60, releaseVelocity: 0 }),
  );
  expect(gesture.active()).toBe(false);
});

it("continues from initial progress and ignores non-primary pointers", () => {
  const progress = vi.fn();
  const gesture = createHorizontalPan({
    commitRatio: 0.5,
    commitVelocity: 0.25,
    direction: "right",
    onCancel: vi.fn(),
    onCommit: vi.fn(),
    onProgress: progress,
  });

  gesture.begin(pointer(8, 100, 100, 0, false), 300, 0.4);
  expect(gesture.active()).toBe(false);
  gesture.begin(pointer(9, 100, 100, 0), 300, 0.4);
  gesture.move(pointer(9, 120, 100, 20));
  gesture.move(pointer(9, 150, 100, 40));
  expect(progress).toHaveBeenLastCalledWith(0.5);
});

it("uses release direction when deciding by distance", () => {
  expect(panCommits(149, 300, 0.2, 0.5, 0.25)).toBe(false);
  expect(panCommits(150, 300, 0, 0.5, 0.25)).toBe(false);
  expect(panCommits(151, 300, 0, 0.5, 0.25)).toBe(true);
  expect(panCommits(151, 300, -0.01, 0.5, 0.25)).toBe(false);
  expect(panCommits(40, 300, 0.25, 0.5, 0.25)).toBe(true);
  expect(panCommits(0, 300, 1, 0.5, 0.25)).toBe(false);
});

function pointer(
  pointerId: number,
  clientX: number,
  clientY: number,
  timeStamp: number,
  isPrimary?: boolean,
): PointerEvent {
  return {
    clientX,
    clientY,
    currentTarget: null,
    isPrimary,
    pointerId,
    preventDefault: vi.fn(),
    timeStamp,
  } as unknown as PointerEvent;
}
