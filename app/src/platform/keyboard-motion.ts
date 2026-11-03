import {
  type KeyboardLayoutCommit,
  type KeyboardLayoutWillCommit,
  keyboardLayoutCommitEvent,
  keyboardLayoutWillCommitEvent,
} from "./viewport-geometry";

export const keyboardMotionEnabled = false;

const durationMilliseconds = 400;
const closeLeadMilliseconds = 20;
const correctionMilliseconds = 100;
const measuredSpring =
  "linear(0, .024 2.5%, .081 5%, .158 7.5%, .243 10%, .329 12.5%, .412 15%, .490 17.5%, .561 20%, .681 25%, .773 30%, .841 35%, .890 40%, .948 50%, .977 60%, .990 70%, .997 85%, 1)";
const springFallback = "cubic-bezier(.285,.9,.285,1)";

export interface KeyboardMotionOptions {
  readonly enabled?: boolean;
  readonly prefersReducedMotion?: () => boolean;
}

interface OpeningSnapshot {
  readonly composer: HTMLElement;
  readonly composerTop: number;
  readonly screen: HTMLElement;
  readonly transcript: HTMLElement;
}

interface OpeningLayout {
  readonly snapshot: HTMLElement;
  readonly screen: HTMLElement;
}

interface ClosingSnapshot {
  readonly composer: HTMLElement;
  readonly composerBottom: number;
  readonly viewportHeight: number;
}

interface ClosingMotion extends ClosingSnapshot {
  readonly animation: Animation;
  checkFrame: number;
}

export function observeKeyboardMotion(
  root: HTMLElement,
  browserWindow: Window,
  {
    enabled = keyboardMotionEnabled || __KEYBOARD_MOTION_TEST_ENABLED__,
    prefersReducedMotion = () => false,
  }: KeyboardMotionOptions = {},
): () => void {
  let opening: OpeningSnapshot | undefined;
  let openingLayout: OpeningLayout | undefined;
  let closingSnapshot: ClosingSnapshot | undefined;
  let closing: ClosingMotion | undefined;
  const running = new Set<Animation>();
  const clearOpeningLayout = (layout = openingLayout) => {
    if (layout === undefined || openingLayout !== layout) return;
    delete root.dataset.keyboardMotion;
    layout.snapshot.remove();
    layout.screen.style.removeProperty("--wl-keyboard-composer-height");
    openingLayout = undefined;
  };
  const cancelRunning = () => {
    const closingMotion = closing;
    if (closingMotion !== undefined && closingMotion.checkFrame !== 0)
      browserWindow.cancelAnimationFrame(closingMotion.checkFrame);
    closing = undefined;
    for (const animation of running) animation.cancel();
    running.clear();
    clearOpeningLayout();
  };
  const willCommit = (event: Event) => {
    opening = undefined;
    closingSnapshot = undefined;
    const detail = (event as CustomEvent<KeyboardLayoutWillCommit>).detail;
    if (
      !enabled ||
      prefersReducedMotion() ||
      root.dataset.shell !== "mobile" ||
      detail.owner !== root
    )
      return;
    const surfaces = motionSurfaces(root);
    if (surfaces === undefined) return;
    const composerRect = surfaces.composer.getBoundingClientRect();
    const composerBottom = composerRect.bottom;
    cancelRunning();
    if (
      detail.previousGeometry.keyboard === "closed" &&
      detail.geometry.keyboard === "open"
    ) {
      const layout = {
        screen: surfaces.screen,
        snapshot: createTranscriptSnapshot(
          surfaces.transcript,
          surfaces.screen,
        ),
      };
      openingLayout = layout;
      root.dataset.keyboardMotion = "opening";
      surfaces.screen.style.setProperty(
        "--wl-keyboard-composer-height",
        `${composerRect.height}px`,
      );
      opening = { ...surfaces, composerTop: composerRect.top };
    } else if (
      detail.previousGeometry.keyboard === "open" &&
      detail.geometry.keyboard === "closed"
    ) {
      closingSnapshot = {
        composer: surfaces.composer,
        composerBottom,
        viewportHeight: viewportHeight(browserWindow),
      };
    }
  };
  const didCommit = (event: Event) => {
    const detail = (event as CustomEvent<KeyboardLayoutCommit>).detail;
    const snapshot = opening;
    opening = undefined;
    if (snapshot === undefined || detail.geometry.keyboard !== "open") {
      const closingStart = closingSnapshot;
      closingSnapshot = undefined;
      if (closingStart !== undefined && detail.geometry.keyboard === "closed")
        startClosing(closingStart);
      return;
    }
    const committedComposerTop = snapshot.composer.getBoundingClientRect().top;
    const delta = snapshot.composerTop - committedComposerTop;
    if (Math.abs(delta) <= 1) return;
    const timing = motionTiming(browserWindow);
    const options: KeyframeAnimationOptions = {
      duration: timing.duration,
      easing: timing.easing,
      fill: "both",
    };
    const transcriptDelta = committedComposerTop - snapshot.composerTop;
    const composerAnimation = snapshot.composer.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
      options,
    );
    const transcriptAnimation = snapshot.transcript.animate.call(
      openingLayout?.snapshot.querySelector<HTMLElement>(
        "[data-keyboard-transcript-snapshot-layer]",
      ) ?? snapshot.transcript,
      [
        { transform: "none" },
        { transform: `translateY(${transcriptDelta}px)` },
      ],
      options,
    );
    track(composerAnimation, running);
    track(transcriptAnimation, running);
    browserWindow.queueMicrotask(() => {
      if (!running.has(composerAnimation) || !running.has(transcriptAnimation))
        return;
      const commitTime = browserWindow.performance.now();
      anchorAnimation(composerAnimation, commitTime);
      anchorAnimation(transcriptAnimation, commitTime);
    });
    const layout = openingLayout;
    if (layout !== undefined)
      void transcriptAnimation.finished.then(
        () => {
          if (openingLayout !== layout) return;
          root.dataset.keyboardMotion = "open";
          layout.snapshot.remove();
        },
        () => undefined,
      );
  };
  const startClosing = (snapshot: ClosingSnapshot) => {
    const delta =
      snapshot.composerBottom -
      snapshot.composer.getBoundingClientRect().bottom;
    if (Math.abs(delta) <= 1) return;
    const timing = motionTiming(browserWindow);
    const animation = snapshot.composer.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
      {
        delay: -closeLeadMilliseconds,
        duration: timing.duration,
        easing: timing.easing,
        fill: "both",
      },
    );
    const state: ClosingMotion = { ...snapshot, animation, checkFrame: 0 };
    closing = state;
    running.add(animation);
    watchClosing(state);
    state.checkFrame = browserWindow.requestAnimationFrame(() => {
      state.checkFrame = browserWindow.requestAnimationFrame(() => {
        state.checkFrame = 0;
        if (
          closing === state &&
          viewportHeight(browserWindow) <= state.viewportHeight + 1
        ) {
          state.animation.reverse();
          watchClosing(state);
        }
      });
    });
  };
  const watchClosing = (state: ClosingMotion) => {
    const finished = state.animation.finished;
    void finished.then(
      () => {
        if (closing !== state) return;
        if (state.animation.playbackRate < 0) return;
        finishClosing(state);
      },
      () => undefined,
    );
  };
  const finishClosing = (state: ClosingMotion) => {
    closing = undefined;
    running.delete(state.animation);
    state.animation.cancel();
    const viewportBottom =
      (browserWindow.visualViewport?.offsetTop ?? 0) +
      viewportHeight(browserWindow);
    const correction =
      viewportBottom - state.composer.getBoundingClientRect().bottom;
    if (Math.abs(correction) <= 1) return;
    track(
      state.composer.animate(
        [{ transform: `translateY(${correction}px)` }, { transform: "none" }],
        {
          duration: correctionMilliseconds,
          easing: springFallback,
          fill: "both",
        },
      ),
      running,
    );
  };
  const viewportChanged = () => {
    const state = closing;
    if (
      state === undefined ||
      viewportHeight(browserWindow) <= state.viewportHeight + 1 ||
      state.animation.playbackRate >= 0
    )
      return;
    state.animation.reverse();
    watchClosing(state);
  };
  browserWindow.addEventListener(keyboardLayoutWillCommitEvent, willCommit);
  browserWindow.addEventListener(keyboardLayoutCommitEvent, didCommit);
  browserWindow.visualViewport?.addEventListener("resize", viewportChanged);
  return () => {
    browserWindow.removeEventListener(
      keyboardLayoutWillCommitEvent,
      willCommit,
    );
    browserWindow.removeEventListener(keyboardLayoutCommitEvent, didCommit);
    browserWindow.visualViewport?.removeEventListener(
      "resize",
      viewportChanged,
    );
    cancelRunning();
    opening = undefined;
    closingSnapshot = undefined;
  };
}

function viewportHeight(browserWindow: Window): number {
  return browserWindow.visualViewport?.height ?? browserWindow.innerHeight;
}

function motionSurfaces(root: HTMLElement):
  | {
      readonly composer: HTMLElement;
      readonly screen: HTMLElement;
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
      return { composer, screen, transcript };
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

function createTranscriptSnapshot(
  transcript: HTMLElement,
  screen: HTMLElement,
): HTMLElement {
  const list = transcript.closest<HTMLElement>("[data-message-list]");
  const listRect =
    list?.getBoundingClientRect() ?? transcript.getBoundingClientRect();
  const transcriptRect = transcript.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const snapshot = document.createElement("div");
  const layer = transcript.cloneNode(true) as HTMLElement;
  layer.removeAttribute("data-message-motion-layer");
  layer.dataset.keyboardTranscriptSnapshotLayer = "true";
  layer.setAttribute("aria-hidden", "true");
  layer.style.height = `${transcriptRect.height}px`;
  layer.style.left = "0";
  layer.style.pointerEvents = "auto";
  layer.style.position = "absolute";
  layer.style.top = `${transcriptRect.top - listRect.top}px`;
  layer.style.width = "100%";
  if (list !== null) {
    snapshot.className = list.className;
    snapshot.dataset.presentation = list.dataset.presentation;
  }
  snapshot.dataset.keyboardTranscriptSnapshot = "true";
  snapshot.style.bottom = "0";
  snapshot.style.left = `${listRect.left - screenRect.left}px`;
  snapshot.style.overflow = "clip";
  snapshot.style.padding = "0";
  snapshot.style.pointerEvents = "none";
  snapshot.style.position = "absolute";
  snapshot.style.top = `${listRect.top - screenRect.top}px`;
  snapshot.style.width = `${listRect.width}px`;
  snapshot.style.zIndex = "2";
  snapshot.append(layer);
  screen.append(snapshot);
  return snapshot;
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

function anchorAnimation(animation: Animation, startTime: number): void {
  if (animation.playState === "paused") animation.currentTime = 0;
  else animation.startTime = startTime;
}
