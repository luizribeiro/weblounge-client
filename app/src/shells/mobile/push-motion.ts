import type { MobileTransition } from "./mobile-navigation";

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
