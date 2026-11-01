import { type DebugReading, installDebugSection } from "./debug-overlay";
import {
  type KeyboardLayoutCommit,
  keyboardLayoutCommitEvent,
} from "./viewport-geometry";

const traceMilliseconds = 1000;
const header = "ms sy vo vh ih rt rh ct";
export const keyboardInteractionEvent = "weblounge:keyboard-interaction";

export type KeyboardInteractionLabel =
  | "focus:landed"
  | "focus:refused"
  | "focusin:composer"
  | "touchcancel"
  | "touchend:rejected"
  | "touchend:tap"
  | "touchstart";

interface KeyboardInteraction {
  readonly at: number;
  readonly label: KeyboardInteractionLabel;
}

export function reportKeyboardInteraction(
  label: KeyboardInteractionLabel,
  browserWindow: Window = window,
): void {
  browserWindow.dispatchEvent(
    new CustomEvent<KeyboardInteraction>(keyboardInteractionEvent, {
      detail: { at: browserWindow.performance.now(), label },
    }),
  );
}

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

export function summarizeKeyboardTrace(
  frames: readonly KeyboardTraceFrame[],
): string {
  if (frames.length === 0) return "waiting · tap after a trace to copy";
  return [
    `${frames.length} frames · tap to copy full trace`,
    `sy ${range(frames, "scrollY")} · vo ${range(frames, "viewportOffsetTop")}`,
    `vh ${range(frames, "viewportHeight")} · ih ${range(frames, "innerHeight")}`,
    `rt ${range(frames, "rootTop")} · rh ${range(frames, "rootHeight")}`,
    `ct ${range(frames, "composerTop")}`,
  ].join("\n");
}

export function installKeyboardDebug(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  let frames: readonly KeyboardTraceFrame[] = [];
  let commits: readonly string[] = [];
  let interactions: readonly string[] = [];
  let interactionStartedAt = 0;
  let trigger = "waiting for tap/focusout";
  let animationFrame = 0;
  const stopSection = installDebugSection(browserWindow, {
    id: "keyboard",
    title: "keyboard",
    read: (): readonly DebugReading[] => [
      ["trigger", trigger],
      ["commits", commits.join(" · ") || "waiting"],
      ["interactions", interactions.join(" · ") || "waiting"],
      ["trace", summarizeKeyboardTrace(frames)],
    ],
    subscribe: (render) => {
      const overlay = browserWindow.document.querySelector<HTMLElement>(
        "[data-debug-overlay]",
      );
      if (overlay !== null) overlay.dataset.debugCopy = "keyboard";
      const stopTraceTap = (event: Event) => event.stopPropagation();
      const copyTrace = (event: Event) => {
        event.stopPropagation();
        void browserWindow.navigator.clipboard?.writeText(
          [
            "[interactions]",
            ...interactions,
            "[frames]",
            formatKeyboardTrace(frames),
          ].join("\n"),
        );
      };
      overlay?.addEventListener("pointerdown", stopTraceTap);
      overlay?.addEventListener("pointerup", stopTraceTap);
      overlay?.addEventListener("click", copyTrace);
      const record = (event: Event) => {
        if (!startsKeyboardTrace(event)) return;
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
      const recordCommit = (event: Event) => {
        const { geometry, source } = (
          event as CustomEvent<KeyboardLayoutCommit>
        ).detail;
        commits = [
          ...commits,
          `${source}:${geometry.keyboard === "open" ? geometry.height : "closed"}`,
        ].slice(-5);
        render();
      };
      const recordInteraction = (event: Event) => {
        const { at, label } = (event as CustomEvent<KeyboardInteraction>)
          .detail;
        if (label === "touchstart" || interactions.length === 0) {
          interactionStartedAt = at;
          interactions = [];
        }
        interactions = [
          ...interactions,
          `${compact(at - interactionStartedAt)} ${label}`,
        ].slice(-12);
        render();
      };
      const recordComposerFocus = (event: FocusEvent) => {
        if (
          !(event.target instanceof Element) ||
          event.target.closest("[data-composer]") === null
        )
          return;
        reportKeyboardInteraction("focusin:composer", browserWindow);
      };
      browserWindow.addEventListener("pointerup", record);
      browserWindow.addEventListener("focusout", record);
      browserWindow.addEventListener("focusin", recordComposerFocus);
      browserWindow.addEventListener(keyboardLayoutCommitEvent, recordCommit);
      browserWindow.addEventListener(
        keyboardInteractionEvent,
        recordInteraction,
      );
      return () => {
        if (animationFrame !== 0)
          browserWindow.cancelAnimationFrame(animationFrame);
        browserWindow.removeEventListener("pointerup", record);
        browserWindow.removeEventListener("focusout", record);
        browserWindow.removeEventListener("focusin", recordComposerFocus);
        browserWindow.removeEventListener(
          keyboardLayoutCommitEvent,
          recordCommit,
        );
        browserWindow.removeEventListener(
          keyboardInteractionEvent,
          recordInteraction,
        );
        overlay?.removeEventListener("pointerdown", stopTraceTap);
        overlay?.removeEventListener("pointerup", stopTraceTap);
        overlay?.removeEventListener("click", copyTrace);
        if (overlay?.dataset.debugCopy === "keyboard")
          delete overlay.dataset.debugCopy;
      };
    },
  });
  return stopSection;
}

function primaryPointer(event: Event): boolean {
  return !(event instanceof PointerEvent) || event.isPrimary;
}

function startsKeyboardTrace(event: Event): boolean {
  if (event.type === "pointerup") return primaryPointer(event);
  return (
    event.type === "focusout" &&
    event.target instanceof Element &&
    event.target.closest("[data-composer]") !== null
  );
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

function range(
  frames: readonly KeyboardTraceFrame[],
  key: Exclude<keyof KeyboardTraceFrame, "elapsed">,
): string {
  const values = frames.map((frame) => frame[key]);
  return `${compact(Math.min(...values))}…${compact(Math.max(...values))}`;
}
