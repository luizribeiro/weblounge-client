import { type DebugReading, installDebugSection } from "./debug-overlay";

const traceMilliseconds = 1000;
const header = "ms sy vo vh ih rt rh ct";

export interface KeyboardTraceFrame {
  readonly composerTop: number;
  readonly elapsed: number;
  readonly innerHeight: number;
  readonly rootHeight: number;
  readonly rootTop: number;
  readonly scrollY: number;
  readonly viewportHeight: number;
  readonly viewportOffsetTop: number;
}

export function readKeyboardTraceFrame(
  browserWindow: Window,
  root: HTMLElement,
  startedAt: number,
  now: number,
): KeyboardTraceFrame {
  const rootRect = root.getBoundingClientRect();
  const composerRect = browserWindow.document
    .querySelector("[data-composer]")
    ?.getBoundingClientRect();
  return {
    composerTop: composerRect?.top ?? Number.NaN,
    elapsed: now - startedAt,
    innerHeight: browserWindow.innerHeight,
    rootHeight: rootRect.height,
    rootTop: rootRect.top,
    scrollY: browserWindow.scrollY,
    viewportHeight:
      browserWindow.visualViewport?.height ?? browserWindow.innerHeight,
    viewportOffsetTop: browserWindow.visualViewport?.offsetTop ?? 0,
  };
}

export function formatKeyboardTrace(
  frames: readonly KeyboardTraceFrame[],
): string {
  return [header, ...frames.map(formatFrame)].join("\n");
}

export function installKeyboardDebug(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  let frames: readonly KeyboardTraceFrame[] = [];
  let trigger = "waiting for tap/focusout";
  let animationFrame = 0;
  const stopSection = installDebugSection(browserWindow, {
    id: "keyboard",
    title: "keyboard",
    read: (): readonly DebugReading[] => [
      ["trigger", trigger],
      ["trace", frames.length === 0 ? header : formatKeyboardTrace(frames)],
    ],
    subscribe: (render) => {
      const record = (event: Event) => {
        if (event.type === "pointerup" && !primaryPointer(event)) return;
        if (animationFrame !== 0)
          browserWindow.cancelAnimationFrame(animationFrame);
        const startedAt = browserWindow.performance.now();
        trigger = event.type;
        frames = [
          readKeyboardTraceFrame(browserWindow, root, startedAt, startedAt),
        ];
        render();
        const sample = (now: number) => {
          frames = [
            ...frames,
            readKeyboardTraceFrame(browserWindow, root, startedAt, now),
          ];
          render();
          if (now - startedAt < traceMilliseconds) {
            animationFrame = browserWindow.requestAnimationFrame(sample);
          } else {
            animationFrame = 0;
          }
        };
        animationFrame = browserWindow.requestAnimationFrame(sample);
      };
      browserWindow.addEventListener("pointerup", record);
      browserWindow.addEventListener("focusout", record);
      return () => {
        if (animationFrame !== 0)
          browserWindow.cancelAnimationFrame(animationFrame);
        browserWindow.removeEventListener("pointerup", record);
        browserWindow.removeEventListener("focusout", record);
      };
    },
  });
  return stopSection;
}

function primaryPointer(event: Event): boolean {
  return !(event instanceof PointerEvent) || event.isPrimary;
}

function formatFrame(frame: KeyboardTraceFrame): string {
  return [
    frame.elapsed,
    frame.scrollY,
    frame.viewportOffsetTop,
    frame.viewportHeight,
    frame.innerHeight,
    frame.rootTop,
    frame.rootHeight,
    frame.composerTop,
  ]
    .map(compact)
    .join(" ");
}

function compact(value: number): string {
  if (Number.isNaN(value)) return "-";
  return String(Math.round(value * 10) / 10);
}
