import {
  beginGestureDebug,
  type GestureDebugHandle,
} from "../platform/gesture-debug";
import { claimHorizontalTouchMove } from "../platform/touch-move-lock";

export interface PanRelease {
  readonly progressPerMs: number;
  readonly distance: number;
  readonly averageVelocity: number;
  readonly releaseVelocity: number;
}

export interface HorizontalPanOptions {
  readonly direction: "left" | "right";
  readonly commitRatio: number;
  readonly commitVelocity: number;
  readonly debugRegion?: string | undefined;
  readonly preventDefaultOnStart?: boolean | undefined;
  readonly onProgress: (progress: number) => void;
  readonly onCommit: (release: PanRelease) => void;
  readonly onCancel: (release: PanRelease) => void;
}

export interface HorizontalPanGesture {
  readonly active: () => boolean;
  readonly begin: (
    event: PointerEvent,
    width: number,
    initialProgress?: number,
  ) => void;
  readonly move: (event: PointerEvent) => void;
  readonly end: (event: PointerEvent) => void;
  readonly cancel: (event: PointerEvent) => void;
  readonly lostCapture: (event: PointerEvent) => void;
  readonly reset: (reason?: "visibility" | "popstate") => void;
}

interface PanState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly initialProgress: number;
  readonly target: Element | null;
  readonly width: number;
  readonly debug: GestureDebugHandle | undefined;
  axis: "pending" | "horizontal";
  captured: boolean;
  originX: number;
  claimedAt: number;
  lastX: number;
  lastTime: number;
  releaseTouchMove: () => void;
  samples: readonly PanSample[];
}

interface PanSample {
  readonly x: number;
  readonly time: number;
}

const axisLockThreshold = 10;
const releaseVelocityWindow = 100;

export function createHorizontalPan(
  options: HorizontalPanOptions,
): HorizontalPanGesture {
  let state: PanState | undefined;
  const sign = options.direction === "right" ? 1 : -1;
  const signedDelta = (x: number, origin: number) => sign * (x - origin);
  const distance = (x: number, current: PanState) =>
    Math.max(
      0,
      current.initialProgress * current.width + signedDelta(x, current.originX),
    );
  const release = (current: PanState) => {
    current.releaseTouchMove();
    try {
      if (
        current.captured &&
        current.target?.hasPointerCapture(current.pointerId) === true
      )
        current.target.releasePointerCapture(current.pointerId);
    } catch {
      // Synthetic pointer fixtures do not establish browser capture.
    }
  };
  const emptyRelease = (): PanRelease => ({
    averageVelocity: 0,
    distance: 0,
    progressPerMs: 0,
    releaseVelocity: 0,
  });
  const abandon = (current: PanState) => {
    state = undefined;
    release(current);
    const result = emptyRelease();
    current.debug?.rejectAngle();
    current.debug?.up(false, result);
    options.onCancel(result);
  };
  const recentSamples = (current: PanState, x: number, time: number) =>
    [...current.samples, { time, x }].filter(
      (sample) => time - sample.time <= releaseVelocityWindow,
    );
  const releaseVelocity = (current: PanState, x: number, time: number) => {
    const samples = recentSamples(current, x, time);
    const oldest = samples[0];
    const elapsed = time - (oldest?.time ?? time);
    if (oldest === undefined || elapsed <= 0) return 0;
    return (sign * (x - oldest.x)) / elapsed;
  };
  const settle = (current: PanState, x: number, time: number): PanRelease => {
    const releaseSpeed = releaseVelocity(current, x, time);
    return {
      averageVelocity:
        signedDelta(x, current.originX) / Math.max(1, time - current.claimedAt),
      distance: distance(x, current),
      progressPerMs: releaseSpeed / current.width,
      releaseVelocity: releaseSpeed,
    };
  };
  const finish = (
    current: PanState,
    x: number,
    time: number,
    recordUp = true,
  ) => {
    const result = settle(current, x, time);
    state = undefined;
    release(current);
    const committed =
      current.axis === "horizontal" &&
      panCommits(
        result.distance,
        current.width,
        result.releaseVelocity,
        options.commitRatio,
        options.commitVelocity,
      );
    if (recordUp) current.debug?.up(committed, result);
    if (committed) options.onCommit(result);
    else options.onCancel(result);
  };

  return {
    active: () => state !== undefined,
    begin: (event, width, initialProgress = 0) => {
      if (state !== undefined || event.isPrimary === false) return;
      state = {
        axis: "pending",
        captured: false,
        claimedAt: event.timeStamp,
        debug:
          options.debugRegion === undefined
            ? undefined
            : beginGestureDebug(options.debugRegion, event),
        initialProgress,
        lastTime: event.timeStamp,
        lastX: event.clientX,
        originX: event.clientX,
        pointerId: event.pointerId,
        samples: [{ time: event.timeStamp, x: event.clientX }],
        releaseTouchMove: () => {},
        startX: event.clientX,
        startY: event.clientY,
        target:
          event.currentTarget instanceof Element ? event.currentTarget : null,
        width,
      };
      if (options.preventDefaultOnStart === true) event.preventDefault();
    },
    move: (event) => {
      const current = state;
      if (current === undefined || current.pointerId !== event.pointerId)
        return;
      const deltaX = event.clientX - current.startX;
      const deltaY = event.clientY - current.startY;
      if (current.axis === "pending") {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < axisLockThreshold)
          return;
        if (Math.abs(deltaY) >= Math.abs(deltaX)) {
          abandon(current);
          return;
        }
        if (signedDelta(event.clientX, current.startX) <= 0) {
          abandon(current);
          return;
        }
        current.axis = "horizontal";
        current.originX = event.clientX;
        current.claimedAt = event.timeStamp;
        current.samples = [{ time: event.timeStamp, x: event.clientX }];
        current.releaseTouchMove = claimHorizontalTouchMove(current.target);
        current.debug?.claim(deltaX, deltaY, event.timeStamp);
        try {
          current.target?.setPointerCapture(current.pointerId);
          current.captured = current.target !== null;
        } catch {
          // Synthetic pointer fixtures do not establish browser capture.
        }
      }
      event.preventDefault();
      current.lastX = event.clientX;
      current.lastTime = event.timeStamp;
      current.samples = recentSamples(current, event.clientX, event.timeStamp);
      options.onProgress(
        Math.min(1, distance(event.clientX, current) / current.width),
      );
    },
    end: (event) => {
      const current = state;
      if (current === undefined || current.pointerId !== event.pointerId)
        return;
      finish(current, event.clientX, event.timeStamp);
    },
    cancel: (event) => {
      const current = state;
      if (current === undefined || current.pointerId !== event.pointerId)
        return;
      if (current.axis === "horizontal") {
        current.debug?.pointerCancel(
          event.clientX - current.startX,
          event.clientY - current.startY,
          event.timeStamp,
        );
        finish(current, current.lastX, current.lastTime, false);
      } else {
        state = undefined;
        release(current);
        current.debug?.pointerCancel(
          event.clientX - current.startX,
          event.clientY - current.startY,
          event.timeStamp,
        );
        options.onCancel(emptyRelease());
      }
    },
    lostCapture: (event) => {
      const current = state;
      if (current === undefined || current.pointerId !== event.pointerId)
        return;
      if (current.axis === "horizontal") {
        current.debug?.lostCapture();
        finish(current, current.lastX, current.lastTime, false);
      } else {
        state = undefined;
        release(current);
        current.debug?.lostCapture();
        options.onCancel(emptyRelease());
      }
    },
    reset: (reason) => {
      const current = state;
      state = undefined;
      if (current !== undefined) {
        if (reason !== undefined) current.debug?.reset(reason);
        release(current);
      }
    },
  };
}

export function panCommits(
  distance: number,
  width: number,
  velocity: number,
  distanceRatio: number,
  velocityThreshold: number,
): boolean {
  return (
    distance > 0 &&
    (velocity >= velocityThreshold ||
      (distance > width * distanceRatio && velocity >= 0))
  );
}
