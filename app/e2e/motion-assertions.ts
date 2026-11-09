import { expect } from "@playwright/test";

export interface TransitionStyle {
  readonly duration: string;
  readonly property: string;
  readonly timingFunction: string;
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
  expect(normalizedCurve(transition.timingFunction)).toBe(
    normalizedCurve(curveToken),
  );
}

export function expectDistanceScaledTransition(
  transition: TransitionStyle,
  property: string,
  durationToken: string,
  curveToken: string,
  remainingDistance: number,
  allowShorter = false,
): void {
  expect(transition.property).toBe(property);
  expect(normalizedCurve(transition.timingFunction)).toBe(
    normalizedCurve(curveToken),
  );
  const expectedDuration = durationMs(durationToken) * remainingDistance;
  const actualDuration = durationMs(transition.duration);
  if (allowShorter) {
    expect(actualDuration).toBeGreaterThan(0);
    expect(actualDuration).toBeLessThan(expectedDuration);
  } else {
    expect(Math.abs(actualDuration - expectedDuration)).toBeLessThanOrEqual(
      0.001,
    );
  }
}

export function normalizedCurve(curve: string): string {
  return curve.replace(/\s+/g, "").replace(/(^|[(,])\./g, "$10.");
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

export function expectEqualAtDevicePixelPrecision(
  actual: number,
  expected: number,
  devicePixelRatio: number,
): void {
  expectAtMostAtDevicePixelPrecision(actual, expected, devicePixelRatio);
  expectAtMostAtDevicePixelPrecision(expected, actual, devicePixelRatio);
}

function expectAtMostAtDevicePixelPrecision(
  actual: number,
  bound: number,
  devicePixelRatio: number,
): void {
  if (!(devicePixelRatio > 0))
    throw new Error(`unexpected device pixel ratio: ${devicePixelRatio}`);
  // getBoundingClientRect exposes fractional compositor transforms; only an
  // excess that rounds to a physical pixel establishes a visible curve jump.
  expect(Math.round((actual - bound) * devicePixelRatio)).toBeLessThanOrEqual(
    0,
  );
}

export function durationMs(duration: string): number {
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(duration.trim());
  if (match === null) throw new Error(`unexpected duration: ${duration}`);
  const value = Number(match[1]);
  return match[2] === "s" ? value * 1_000 : value;
}
