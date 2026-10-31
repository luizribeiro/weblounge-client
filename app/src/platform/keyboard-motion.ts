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
    ? { duration: 333, easing: ios26Spring, platform: "ios" }
    : {
        duration: 500,
        easing: "cubic-bezier(0.38, 0.7, 0.125, 1)",
        platform: "ios",
      };
}

export function openingTarget(change: KeyboardLayoutChange): number {
  if (Math.abs(change.viewportOffsetTop) >= 1) return 0;
  return Math.min(0, change.afterHeight - change.beforeHeight);
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

interface MotionElements {
  readonly anchor: HTMLElement;
  readonly scroller: HTMLElement | undefined;
  readonly scope: HTMLElement;
  readonly surfaces: readonly HTMLElement[];
}

interface MotionOverlay {
  readonly original: HTMLElement;
  readonly previousVisibility: string;
  readonly wrapper: HTMLElement;
}

export class KeyboardMotionController {
  readonly #browserWindow: Window;
  readonly #config: KeyboardMotionConfig;
  readonly #reducedMotion: () => boolean;
  #animations: Animation[] = [];
  #animatedScope: HTMLElement | undefined;
  #generation = 0;
  #overlays: MotionOverlay[] = [];
  #restoreLiveEdge = false;
  #scroller: HTMLElement | undefined;

  constructor(
    browserWindow: Window,
    config: KeyboardMotionConfig,
    reducedMotion: () => boolean,
  ) {
    this.#browserWindow = browserWindow;
    this.#config = config;
    this.#reducedMotion = reducedMotion;
  }

  open(
    change: KeyboardLayoutChange,
    prepare: () => void,
    commit: () => void,
  ): void {
    let elements = this.#elements();
    const target = openingTarget(change);
    const currentTop = elements?.anchor.getBoundingClientRect().top;
    this.#cancelAnimation();
    if (elements !== undefined) elements = this.#activate(elements);
    prepare();
    const from =
      currentTop === undefined || elements === undefined
        ? 0
        : currentTop - elements.anchor.getBoundingClientRect().top;
    const animate =
      elements !== undefined &&
      target !== from &&
      Math.abs(change.viewportOffsetTop) < 1 &&
      !this.#reducedMotion();
    if (!animate || elements === undefined) {
      commit();
      this.#cancelAnimation();
      return;
    }
    this.#animate(elements, from, target, commit);
  }

  beginClose(distance: number, prepare: () => void, commit: () => void): void {
    let elements = this.#elements();
    const currentTop = elements?.anchor.getBoundingClientRect().top;
    this.#cancelAnimation();
    if (elements !== undefined) elements = this.#activate(elements);
    prepare();
    const from =
      currentTop === undefined || elements === undefined
        ? 0
        : currentTop - elements.anchor.getBoundingClientRect().top;
    const animate =
      elements !== undefined && distance !== from && !this.#reducedMotion();
    if (!animate || elements === undefined) {
      commit();
      this.#cancelAnimation();
      return;
    }
    this.#animate(elements, from, distance, commit);
  }

  keepOpen(): void {
    this.#cancelAnimation();
  }

  cancel(): void {
    this.#cancelAnimation();
  }

  #elements(): MotionElements | undefined {
    const scope = this.#browserWindow.document.querySelector<HTMLElement>(
      "[data-keyboard-motion]",
    );
    const anchor = scope?.querySelector<HTMLElement>("[data-composer]");
    const scroller =
      scope?.querySelector<HTMLElement>("[data-message-list]") ?? undefined;
    const surfaces = [
      ...(scope?.querySelectorAll<HTMLElement>(
        "[data-keyboard-motion-surface]",
      ) ?? []),
    ];
    return scope === null ||
      scope === undefined ||
      anchor === null ||
      anchor === undefined ||
      surfaces.length === 0
      ? undefined
      : { anchor, scroller, scope, surfaces };
  }

  #animate(
    elements: MotionElements,
    from: number,
    to: number,
    finish: () => void,
  ): void {
    const generation = ++this.#generation;
    this.#animations = elements.surfaces.map((surface) => {
      const [surfaceFrom, surfaceTo] =
        surface === elements.anchor ? [from, to] : [0, to - from];
      return surface.animate(
        [
          { transform: `translateY(${surfaceFrom}px)` },
          { transform: `translateY(${surfaceTo}px)` },
        ],
        {
          duration: this.#config.duration,
          easing: this.#config.easing,
          fill: "both",
        },
      );
    });
    void Promise.all(
      this.#animations.map((animation) => animation.finished),
    ).then(
      () => {
        if (generation !== this.#generation) return;
        finish();
        this.#cancelAnimation();
      },
      () => {},
    );
  }

  #activate(elements: MotionElements): MotionElements {
    elements.scope.dataset.keyboardMotionActive = "true";
    this.#animatedScope = elements.scope;
    this.#scroller = elements.scroller;
    if (elements.scroller !== undefined) {
      this.#restoreLiveEdge =
        elements.scroller.scrollHeight -
          elements.scroller.clientHeight -
          elements.scroller.scrollTop <=
        2;
    }
    const root = elements.scope.closest<HTMLElement>("#root");
    const rowSurfaces = elements.surfaces.filter(
      (surface) => surface !== elements.anchor,
    );
    if (root === null || elements.scroller === undefined) return elements;
    const scrollerRect = elements.scroller.getBoundingClientRect();
    const animatedRows = rowSurfaces.map((surface) => {
      const rect = surface.getBoundingClientRect();
      const wrapper = this.#browserWindow.document.createElement("div");
      wrapper.ariaHidden = "true";
      wrapper.dataset.keyboardMotionOverlay = "true";
      const clone = surface.cloneNode(true) as HTMLElement;
      // Keep the real scroll owner stable while its overscanned rows paint
      // through the keyboard-covered part of the viewport.
      Object.assign(wrapper.style, {
        bottom: "0",
        left: `${scrollerRect.left}px`,
        overflow: "hidden",
        pointerEvents: "none",
        position: "fixed",
        top: `${scrollerRect.top}px`,
        width: `${scrollerRect.width}px`,
        zIndex: "1",
      });
      Object.assign(clone.style, {
        height: `${rect.height}px`,
        inset: "auto",
        left: "0",
        position: "absolute",
        top: `${rect.top - scrollerRect.top}px`,
        width: `${rect.width}px`,
      });
      const previousVisibility = surface.style.visibility;
      surface.style.visibility = "hidden";
      wrapper.append(clone);
      root.append(wrapper);
      this.#overlays.push({ original: surface, previousVisibility, wrapper });
      return clone;
    });
    return { ...elements, surfaces: [...animatedRows, elements.anchor] };
  }

  #cancelAnimation(): void {
    this.#generation += 1;
    for (const animation of this.#animations) animation.cancel();
    this.#animations = [];
    if (this.#animatedScope !== undefined)
      delete this.#animatedScope.dataset.keyboardMotionActive;
    for (const { original, previousVisibility, wrapper } of this.#overlays) {
      original.style.visibility = previousVisibility;
      wrapper.remove();
    }
    this.#overlays = [];
    if (this.#restoreLiveEdge && this.#scroller !== undefined)
      this.#scroller.scrollTop =
        this.#scroller.scrollHeight - this.#scroller.clientHeight;
    this.#restoreLiveEdge = false;
    this.#scroller = undefined;
    this.#animatedScope = undefined;
  }
}
