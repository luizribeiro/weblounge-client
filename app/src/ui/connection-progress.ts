import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";

export type ConnectionProgressPhase =
  | "idle"
  | "loading"
  | "finishing"
  | "filling"
  | "reduced";

interface ConnectionProgressOptions {
  readonly atRest: () => boolean;
  readonly interrupted: Accessor<boolean>;
  readonly prefersReducedMotion: Accessor<boolean>;
}

export interface ConnectionProgress {
  readonly active: Accessor<boolean>;
  readonly phase: Accessor<ConnectionProgressPhase>;
  readonly handleAnimationEnd: (event: AnimationEvent) => void;
  readonly handleAnimationIteration: (event: AnimationEvent) => void;
}

export function connectionSweepAtRest(element: Element | undefined): boolean {
  if (element === undefined || typeof element.getAnimations !== "function")
    return false;
  const animation = element.getAnimations().find((candidate) => {
    const timing = candidate.effect?.getTiming();
    return timing?.duration === 1_000;
  });
  const currentTime = animation?.currentTime;
  if (typeof currentTime !== "number") return false;
  return currentTime % 1_000 >= 750;
}

export function createConnectionProgress(
  progressing: Accessor<boolean>,
  options: ConnectionProgressOptions,
): ConnectionProgress {
  const initialPhase = (): ConnectionProgressPhase => {
    if (!progressing() || options.interrupted()) return "idle";
    return options.prefersReducedMotion() ? "reduced" : "loading";
  };
  const [phase, setPhase] = createSignal(initialPhase());

  createEffect(() => {
    if (progressing()) {
      if (options.interrupted()) setPhase("idle");
      else if (options.prefersReducedMotion()) setPhase("reduced");
      else if (phase() !== "loading") setPhase("loading");
      return;
    }
    if (phase() === "loading") {
      setPhase(options.atRest() ? "filling" : "finishing");
    } else if (phase() === "reduced" || options.interrupted()) {
      setPhase("idle");
    }
  });

  return {
    active: createMemo(() => phase() !== "idle"),
    phase,
    handleAnimationEnd: (event) => {
      if (
        event.target === event.currentTarget &&
        phase() === "filling" &&
        !progressing()
      ) {
        setPhase("idle");
      }
    },
    handleAnimationIteration: (event) => {
      if (
        event.target === event.currentTarget &&
        phase() === "finishing" &&
        !progressing()
      ) {
        setPhase("filling");
      }
    },
  };
}
