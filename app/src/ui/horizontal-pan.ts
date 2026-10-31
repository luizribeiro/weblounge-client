export interface PanRelease {
  readonly progressPerMs: number;
}

export interface HorizontalPanOptions {
  readonly direction: "left" | "right";
  readonly commitRatio: number;
  readonly commitVelocity: number;
  readonly preventDefaultOnStart?: boolean | undefined;
  readonly onProgress: (progress: number) => void;
  readonly onCommit: (release: PanRelease) => void;
  readonly onCancel: (release: PanRelease) => void;
}

export interface HorizontalPanGesture {
  readonly active: () => boolean;
  readonly begin: (event: PointerEvent, width: number) => void;
  readonly move: (event: PointerEvent) => void;
  readonly end: (event: PointerEvent) => void;
  readonly cancel: (event: PointerEvent) => void;
  readonly reset: () => void;
}

interface PanState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
  readonly target: Element | null;
  readonly width: number;
  axis: "pending" | "horizontal";
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
  const signedDistance = (event: PointerEvent, current: PanState) =>
    Math.max(
      0,
      (event.clientX - current.startX) *
        (options.direction === "right" ? 1 : -1),
    );
  const release = (current: PanState) => {
    try {
      if (current.target?.hasPointerCapture(current.pointerId) === true)
        current.target.releasePointerCapture(current.pointerId);
    } catch {
      // Synthetic pointer fixtures do not establish browser capture.
    }
  };
  const abandon = (current: PanState) => {
    release(current);
    state = undefined;
    options.onCancel({ progressPerMs: 0 });
  };
  const recentSamples = (current: PanState, event: PointerEvent) =>
    [...current.samples, { time: event.timeStamp, x: event.clientX }].filter(
      (sample) => event.timeStamp - sample.time <= releaseVelocityWindow,
    );
  const releaseVelocity = (current: PanState, event: PointerEvent) => {
    const samples = recentSamples(current, event);
    const oldest = samples[0];
    const elapsed = event.timeStamp - (oldest?.time ?? event.timeStamp);
    if (oldest === undefined || elapsed <= 0) return 0;
    const sign = options.direction === "right" ? 1 : -1;
    return (sign * (event.clientX - oldest.x)) / elapsed;
  };

  return {
    active: () => state !== undefined,
    begin: (event, width) => {
      state = {
        axis: "pending",
        pointerId: event.pointerId,
        samples: [{ time: event.timeStamp, x: event.clientX }],
        startX: event.clientX,
        startY: event.clientY,
        startedAt: event.timeStamp,
        target:
          event.currentTarget instanceof Element ? event.currentTarget : null,
        width,
      };
      if (options.preventDefaultOnStart === true) event.preventDefault();
      options.onProgress(0);
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
        current.axis = "horizontal";
        try {
          current.target?.setPointerCapture(current.pointerId);
        } catch {
          // Synthetic pointer fixtures do not establish browser capture.
        }
      }
      event.preventDefault();
      current.samples = recentSamples(current, event);
      options.onProgress(
        Math.min(1, signedDistance(event, current) / current.width),
      );
    },
    end: (event) => {
      const current = state;
      if (current === undefined || current.pointerId !== event.pointerId)
        return;
      const distance = signedDistance(event, current);
      const velocity =
        distance / Math.max(1, event.timeStamp - current.startedAt);
      const settle = {
        progressPerMs: releaseVelocity(current, event) / current.width,
      };
      release(current);
      state = undefined;
      if (
        current.axis === "horizontal" &&
        panCommits(
          distance,
          current.width,
          velocity,
          options.commitRatio,
          options.commitVelocity,
        )
      )
        options.onCommit(settle);
      else options.onCancel(settle);
    },
    cancel: (event) => {
      const current = state;
      if (current === undefined || current.pointerId !== event.pointerId)
        return;
      abandon(current);
    },
    reset: () => {
      const current = state;
      if (current !== undefined) release(current);
      state = undefined;
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
    (distance >= width * distanceRatio || velocity >= velocityThreshold)
  );
}
