export interface KeyboardMotionConfig {
  readonly duration: number;
  readonly easing: string;
  readonly platform: "android" | "ios";
}

export interface KeyboardLayoutChange {
  readonly afterHeight: number;
  readonly beforeHeight: number;
  readonly viewportOffsetTop: number;
}

const ios26Spring =
  "linear(0, .1103, .3114, .5045, .6591, .7725, .8515, .9047, .9396, .9621, .9765, .9855, .9911, .9946, .9967, .998, 1)";

export function selectKeyboardMotion(
  userAgent: string,
  virtualKeyboardAvailable: boolean,
): KeyboardMotionConfig {
  if (virtualKeyboardAvailable) {
    return {
      duration: 285,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      platform: "android",
    };
  }
  const major = Number.parseInt(
    /(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)/u.exec(userAgent)?.[1] ?? "0",
    10,
  );
  return major >= 26
    ? { duration: 383, easing: ios26Spring, platform: "ios" }
    : {
        duration: 500,
        easing: "cubic-bezier(0.38, 0.7, 0.125, 1)",
        platform: "ios",
      };
}

export function openingTranslate(
  currentTranslate: number,
  change: KeyboardLayoutChange,
): number {
  if (Math.abs(change.viewportOffsetTop) >= 1) return 0;
  return currentTranslate + change.beforeHeight - change.afterHeight;
}

export function readTranslateY(
  element: HTMLElement,
  browserWindow: Window,
): number {
  const transform = browserWindow.getComputedStyle(element).transform;
  if (transform === "none" || transform === "") return 0;
  const matrix3d = /^matrix3d\((.+)\)$/u.exec(transform);
  if (matrix3d !== null)
    return Number.parseFloat(matrix3d[1]?.split(",")[13] ?? "0") || 0;
  const matrix = /^matrix\((.+)\)$/u.exec(transform);
  if (matrix !== null)
    return Number.parseFloat(matrix[1]?.split(",")[5] ?? "0") || 0;
  return (
    Number.parseFloat(/^translateY\((.+)px\)$/u.exec(transform)?.[1] ?? "0") ||
    0
  );
}

interface PendingClose {
  commit: () => void;
  geometryReady: boolean;
  motionReady: boolean;
  timeout: number;
}

export class KeyboardMotionController {
  readonly #browserWindow: Window;
  readonly #config: KeyboardMotionConfig;
  readonly #reducedMotion: () => boolean;
  #animation: Animation | undefined;
  #animatedSurface: HTMLElement | undefined;
  #generation = 0;
  #pendingClose: PendingClose | undefined;

  constructor(
    browserWindow: Window,
    config: KeyboardMotionConfig,
    reducedMotion: () => boolean,
  ) {
    this.#browserWindow = browserWindow;
    this.#config = config;
    this.#reducedMotion = reducedMotion;
  }

  open(change: KeyboardLayoutChange, commit: () => void): void {
    const surface = this.#surface();
    const current =
      surface === null ? 0 : readTranslateY(surface, this.#browserWindow);
    const anchorBefore = this.#anchor()?.getBoundingClientRect().top;
    const animate =
      surface !== null &&
      Math.abs(change.viewportOffsetTop) < 1 &&
      !this.#reducedMotion();
    this.#cancelPendingClose();
    this.#cancelAnimation();
    if (surface !== null) surface.getBoundingClientRect();
    if (animate) surface.dataset.keyboardMotionActive = "true";
    commit();
    if (!animate || surface === null) return;
    const anchorAfter = this.#anchor()?.getBoundingClientRect().top;
    const from = openingTranslate(current, {
      ...change,
      ...(anchorBefore === undefined || anchorAfter === undefined
        ? {}
        : {
            beforeHeight: anchorBefore - current,
            afterHeight: anchorAfter,
          }),
    });
    if (from === 0) {
      delete surface.dataset.keyboardMotionActive;
      return;
    }
    this.#animate(surface, from, 0);
  }

  beginClose(distance: number, commit: () => void): void {
    const surface = this.#surface();
    const current =
      surface === null ? 0 : readTranslateY(surface, this.#browserWindow);
    this.#cancelPendingClose();
    this.#cancelAnimation();
    const pending: PendingClose = {
      commit,
      geometryReady: false,
      motionReady: surface === null || this.#reducedMotion(),
      timeout: this.#browserWindow.setTimeout(() => {
        pending.geometryReady = true;
        this.#finishClose(pending);
      }, 1000),
    };
    this.#pendingClose = pending;
    if (!pending.motionReady && surface !== null) {
      this.#animate(surface, current, distance, () => {
        pending.motionReady = true;
        this.#finishClose(pending);
      });
    }
    this.#finishClose(pending);
  }

  closeGeometry(commit: () => void): void {
    const pending = this.#pendingClose;
    if (pending === undefined) {
      commit();
      return;
    }
    pending.commit = commit;
    pending.geometryReady = true;
    this.#finishClose(pending);
  }

  cancel(): void {
    this.#cancelPendingClose();
    this.#cancelAnimation();
  }

  #surface(): HTMLElement | null {
    return this.#browserWindow.document.querySelector("[data-keyboard-motion]");
  }

  #anchor(): HTMLElement | null {
    return this.#browserWindow.document.querySelector("[data-composer]");
  }

  #animate(
    surface: HTMLElement,
    from: number,
    to: number,
    finish?: () => void,
  ): void {
    const generation = ++this.#generation;
    surface.dataset.keyboardMotionActive = "true";
    this.#animatedSurface = surface;
    // WKWebView receives only UIKeyboardFrameEndUserInfoKey, so CSS cannot
    // observe native progress. Match the platform transform instead:
    // https://github.com/WebKit/WebKit/blob/e697080/Source/WebKit/UIProcess/API/ios/WKWebViewIOS.mm#L3704-L3790
    // https://github.com/TelegramMessenger/Telegram-iOS/blob/master/submodules/Display/Source/CAAnimationUtils.swift
    // https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/view/InsetsController.java
    const animation = surface.animate(
      [
        { transform: `translateY(${from}px)` },
        { transform: `translateY(${to}px)` },
      ],
      {
        duration: this.#config.duration,
        easing: this.#config.easing,
        fill: "both",
      },
    );
    this.#animation = animation;
    void animation.finished.then(
      () => {
        if (generation !== this.#generation) return;
        finish?.();
        if (finish === undefined) {
          delete surface.dataset.keyboardMotionActive;
          this.#cancelAnimation();
        }
      },
      () => {},
    );
  }

  #finishClose(pending: PendingClose): void {
    if (
      this.#pendingClose !== pending ||
      !pending.geometryReady ||
      !pending.motionReady
    )
      return;
    this.#browserWindow.clearTimeout(pending.timeout);
    this.#pendingClose = undefined;
    pending.commit();
    this.#cancelAnimation();
  }

  #cancelPendingClose(): void {
    const pending = this.#pendingClose;
    if (pending === undefined) return;
    this.#browserWindow.clearTimeout(pending.timeout);
    this.#pendingClose = undefined;
  }

  #cancelAnimation(): void {
    this.#generation += 1;
    this.#animation?.cancel();
    this.#animation = undefined;
    if (this.#animatedSurface !== undefined)
      delete this.#animatedSurface.dataset.keyboardMotionActive;
    this.#animatedSurface = undefined;
  }
}
