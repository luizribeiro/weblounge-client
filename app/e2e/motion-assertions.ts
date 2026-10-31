import { expect } from "@playwright/test";

export interface TransitionStyle {
  readonly duration: string;
  readonly property: string;
  readonly timingFunction: string;
}

export interface PositionSample {
  readonly position: number;
  readonly time: number;
}

export function expectTransitionMatches(
  transition: TransitionStyle,
  property: string,
  durationToken: string,
  curveToken: string,
): void {
  expect(transition.property).toBe(property);
  expect(durationMs(transition.duration)).toBeCloseTo(
    durationMs(durationToken),
    5,
  );
  expect(transition.timingFunction).toBe(curveToken);
}

export function expectNoTransformOrTransition(style: {
  readonly transform: string;
  readonly transitionDuration: string;
}): void {
  expect(style.transform).toBe("none");
  expect(
    style.transitionDuration
      .split(",")
      .every((duration) => durationMs(duration.trim()) === 0),
  ).toBe(true);
}

export function hasIntermediatePosition(
  values: readonly number[],
  start: number,
  end: number,
): boolean {
  const low = Math.min(start, end) + 0.5;
  const high = Math.max(start, end) - 0.5;
  return values.some((value) => value > low && value < high);
}

export function expectStepsFollowCurve(
  samples: readonly PositionSample[],
  start: PositionSample,
  end: number,
  transition: TransitionStyle,
): void {
  const duration = durationMs(transition.duration);
  const curve = cubicBezier(transition.timingFunction);
  const distance = Math.abs(end - start.position);
  let previous = start;
  for (const sample of samples) {
    const elapsed = Math.max(0, sample.time - previous.time);
    const timeFraction = duration === 0 ? 1 : Math.min(1, elapsed / duration);
    const allowed = distance * maximumCurveAdvance(curve, timeFraction) + 3;
    expect(Math.abs(sample.position - previous.position)).toBeLessThanOrEqual(
      allowed,
    );
    previous = sample;
  }
}

export function durationMs(duration: string): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(duration.trim());
  if (match === null) throw new Error(`unexpected duration: ${duration}`);
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1_000 : value;
}

interface Bezier {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function cubicBezier(value: string): Bezier {
  const match = /^cubic-bezier\(([^,]+), ([^,]+), ([^,]+), ([^)]+)\)$/.exec(
    value,
  );
  if (match === null) throw new Error(`unexpected timing function: ${value}`);
  return {
    x1: Number(match[1]),
    y1: Number(match[2]),
    x2: Number(match[3]),
    y2: Number(match[4]),
  };
}

function maximumCurveAdvance(curve: Bezier, width: number): number {
  if (width >= 1) return 1;
  let maximum = 0;
  for (let index = 0; index <= 200; index += 1) {
    const start = ((1 - width) * index) / 200;
    maximum = Math.max(
      maximum,
      easedProgress(start + width, curve) - easedProgress(start, curve),
    );
  }
  return maximum;
}

function easedProgress(progress: number, curve: Bezier): number {
  let low = 0;
  let high = 1;
  for (let index = 0; index < 20; index += 1) {
    const parameter = (low + high) / 2;
    if (bezierCoordinate(parameter, curve.x1, curve.x2) < progress)
      low = parameter;
    else high = parameter;
  }
  return bezierCoordinate((low + high) / 2, curve.y1, curve.y2);
}

function bezierCoordinate(
  parameter: number,
  first: number,
  second: number,
): number {
  const inverse = 1 - parameter;
  return (
    3 * inverse * inverse * parameter * first +
    3 * inverse * parameter * parameter * second +
    parameter * parameter * parameter
  );
}
