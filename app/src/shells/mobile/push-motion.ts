import { motionTokens } from "../../theme/theme-registry";
import type { MobileTransition } from "./mobile-navigation";

export interface ReleasedSwipe {
  readonly phase: "returning" | "completing";
  readonly durationScale: number;
}

export type SwipeMotion =
  | { readonly phase: "dragging"; readonly progress: number }
  | { readonly phase: "returning" | "completing" };

export type PushMotion =
  | SwipeMotion
  | { readonly phase: "entering" | "opening" | "closing" };

export type PushPhase = PushMotion["phase"];

export function pushOffset(motion: PushMotion): number {
  switch (motion.phase) {
    case "entering":
    case "closing":
    case "completing":
      return 1;
    case "opening":
    case "returning":
      return 0;
    case "dragging":
      return motion.progress;
  }
}

export function settlesByTransition(phase: PushPhase): boolean {
  return phase !== "entering" && phase !== "dragging";
}

export function stackMotion(
  transition: MobileTransition,
  painted: boolean,
): PushMotion {
  if (transition.direction === "pop") return { phase: "closing" };
  return { phase: painted ? "opening" : "entering" };
}

// Above 1.3x one 60Hz frame of the settle curve covers less than a sixth of the
// remaining travel; 1.8x keeps a near-stationary release from dragging on.
const settleScaleBounds = { min: 1.3, max: 1.8 } as const;
const settleStartSlope = bezierStartSlope(motionTokens.settleCurve);
const settleBaseMs = milliseconds(motionTokens.pushOut);

export function releasedSwipe(
  phase: ReleasedSwipe["phase"],
  progress: number,
  velocity: number,
): ReleasedSwipe {
  const remaining = phase === "completing" ? 1 - progress : progress;
  const towardTarget = phase === "completing" ? velocity : -velocity;
  return {
    durationScale: settleDurationScale(remaining, towardTarget),
    phase,
  };
}

// Sized so the settle curve starts at the finger's release speed: a flick
// finishes sooner, a slow release eases, and neither leaves the finger with a jump.
export function settleDurationScale(
  remaining: number,
  velocity: number,
): number {
  if (!(velocity > 0)) return settleScaleBounds.max;
  const matched = (settleStartSlope * remaining) / velocity / settleBaseMs;
  return Math.min(
    settleScaleBounds.max,
    Math.max(settleScaleBounds.min, matched),
  );
}

export function bezierStartSlope(curve: string): number {
  const points = /^cubic-bezier\(([\d.]+), ([\d.]+), [\d.]+, [\d.]+\)$/.exec(
    curve,
  );
  const x1 = Number(points?.[1]);
  const y1 = Number(points?.[2]);
  if (!(x1 > 0) || Number.isNaN(y1))
    throw new Error(`settle curve has no finite start slope: ${curve}`);
  return y1 / x1;
}

export function milliseconds(duration: string): number {
  const match = /^(\d+)ms$/.exec(duration);
  if (match === null)
    throw new Error(`expected a millisecond token: ${duration}`);
  return Number(match[1]);
}
