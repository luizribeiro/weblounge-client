export interface ZoomRange {
  readonly fit: number;
  readonly max: number;
}

const zoomStep = 1.5;

export function secondaryZoom(fit: number): number {
  return Math.max(1, 2 * fit);
}

export function maxZoom(fit: number): number {
  return Math.max(4, secondaryZoom(fit));
}

export function clampZoom(level: number, range: ZoomRange): number {
  return Math.min(range.max, Math.max(range.fit, level));
}

export function steppedZoom(
  current: number,
  direction: "in" | "out",
  range: ZoomRange,
): number {
  return clampZoom(
    direction === "in" ? current * zoomStep : current / zoomStep,
    range,
  );
}

export function tokenMilliseconds(value: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)(ms|s)\s*$/u.exec(value);
  if (match?.[1] === undefined) return 0;
  const amount = Number(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}
