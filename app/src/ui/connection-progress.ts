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
  readonly interrupted: Accessor<boolean>;
  readonly prefersReducedMotion: Accessor<boolean>;
  readonly sweepPosition: () => number;
}

export interface ConnectionProgress {
  readonly active: Accessor<boolean>;
  readonly phase: Accessor<ConnectionProgressPhase>;
  readonly handleAnimationEnd: (event: AnimationEvent) => void;
  readonly handleAnimationIteration: (event: AnimationEvent) => void;
}

export function readConnectionSweep(element: Element | undefined): number {
  if (element === undefined) return Number.NEGATIVE_INFINITY;
  const value = getComputedStyle(element).getPropertyValue(
    "--wl-connection-sweep",
  );
  const position = Number.parseFloat(value);
  return Number.isFinite(position) ? position : Number.NEGATIVE_INFINITY;
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
      setPhase(options.sweepPosition() >= 205 ? "filling" : "finishing");
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
