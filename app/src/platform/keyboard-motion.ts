import {
  type KeyboardLayoutCommit,
  type KeyboardLayoutWillCommit,
  keyboardLayoutCommitEvent,
  keyboardLayoutWillCommitEvent,
} from "./viewport-geometry";

export const keyboardMotionEnabled = true;

const durationMilliseconds = 400;
const openLeadMilliseconds = 20;
const measuredSpring =
  "linear(0, .024 2.5%, .081 5%, .158 7.5%, .243 10%, .329 12.5%, .412 15%, .490 17.5%, .561 20%, .681 25%, .773 30%, .841 35%, .890 40%, .948 50%, .977 60%, .990 70%, .997 85%, 1)";
const springFallback = "cubic-bezier(.285,.9,.285,1)";

export interface KeyboardMotionOptions {
  readonly enabled?: boolean;
  readonly prefersReducedMotion?: () => boolean;
}

interface OpeningSnapshot {
  readonly composer: HTMLElement;
  readonly composerBottom: number;
  readonly transcript: HTMLElement;
}

export function observeKeyboardMotion(
  root: HTMLElement,
  browserWindow: Window,
  {
    enabled = keyboardMotionEnabled,
    prefersReducedMotion = () => false,
  }: KeyboardMotionOptions = {},
): () => void {
  let opening: OpeningSnapshot | undefined;
  const running = new Set<Animation>();
  const cancelRunning = () => {
    for (const animation of running) animation.cancel();
    running.clear();
  };
  const willCommit = (event: Event) => {
    opening = undefined;
    const detail = (event as CustomEvent<KeyboardLayoutWillCommit>).detail;
    if (
      !enabled ||
      prefersReducedMotion() ||
      root.dataset.shell !== "mobile" ||
      detail.owner !== root ||
      detail.previousGeometry.keyboard !== "closed" ||
      detail.geometry.keyboard !== "open"
    )
      return;
    const surfaces = motionSurfaces(root);
    if (surfaces === undefined) return;
    cancelRunning();
    opening = {
      ...surfaces,
      composerBottom: surfaces.composer.getBoundingClientRect().bottom,
    };
  };
  const didCommit = (event: Event) => {
    const detail = (event as CustomEvent<KeyboardLayoutCommit>).detail;
    const snapshot = opening;
    opening = undefined;
    if (snapshot === undefined || detail.geometry.keyboard !== "open") return;
    const delta =
      snapshot.composerBottom -
      snapshot.composer.getBoundingClientRect().bottom;
    if (Math.abs(delta) <= 1) return;
    const timing = motionTiming(browserWindow);
    const options: KeyframeAnimationOptions = {
      delay: -openLeadMilliseconds,
      duration: timing.duration,
      easing: timing.easing,
      fill: "both",
    };
    track(
      snapshot.composer.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        options,
      ),
      running,
    );
    track(
      snapshot.transcript.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
        options,
      ),
      running,
    );
  };
  browserWindow.addEventListener(keyboardLayoutWillCommitEvent, willCommit);
  browserWindow.addEventListener(keyboardLayoutCommitEvent, didCommit);
  return () => {
    browserWindow.removeEventListener(
      keyboardLayoutWillCommitEvent,
      willCommit,
    );
    browserWindow.removeEventListener(keyboardLayoutCommitEvent, didCommit);
    cancelRunning();
    opening = undefined;
  };
}

function motionSurfaces(root: HTMLElement):
  | {
      readonly composer: HTMLElement;
      readonly transcript: HTMLElement;
    }
  | undefined {
  const screens = root.querySelectorAll<HTMLElement>(
    "[data-mobile-chat]:not([aria-hidden='true'])",
  );
  for (const screen of screens) {
    const composer = screen.querySelector<HTMLElement>("[data-composer]");
    const transcript = screen.querySelector<HTMLElement>(
      "[data-message-motion-layer]",
    );
    if (composer !== null && transcript !== null)
      return { composer, transcript };
  }
  return undefined;
}

function motionTiming(browserWindow: Window): {
  readonly duration: number;
  readonly easing: string;
} {
  const css = (
    browserWindow as Window & {
      readonly CSS?: { supports(property: string, value: string): boolean };
    }
  ).CSS;
  return css?.supports("animation-timing-function", measuredSpring) === true
    ? { duration: durationMilliseconds, easing: measuredSpring }
    : { duration: 380, easing: springFallback };
}

function track(animation: Animation, running: Set<Animation>): void {
  running.add(animation);
  void animation.finished.then(
    () => {
      running.delete(animation);
      animation.cancel();
    },
    () => {
      running.delete(animation);
    },
  );
}
