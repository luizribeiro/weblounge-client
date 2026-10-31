import { motionTokens } from "../../theme/theme-registry";
import type { MobileTransition } from "./mobile-navigation";

export interface ReleasedSwipe {
  readonly phase: "returning" | "completing";
  readonly durationScale: number;
}

export type SwipeMotion =
  | { readonly phase: "dragging"; readonly progress: number }
  | ReleasedSwipe;

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

const popBaseMs = milliseconds(motionTokens.pop);

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

export function settleDurationScale(
  remaining: number,
  velocity: number,
): number {
  if (!(velocity > 0)) return remaining;
  const velocityMatched = remaining / velocity / popBaseMs;
  return Math.min(remaining, velocityMatched);
}

export function milliseconds(duration: string): number {
  const match = /^(\d+)ms$/.exec(duration);
  if (match === null)
    throw new Error(`expected a millisecond token: ${duration}`);
  return Number(match[1]);
}
