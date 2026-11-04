import { type DebugReading, installDebugSection } from "./debug-overlay";
import {
  type KeyboardLayoutCommit,
  type KeyboardRollbackDecision,
  keyboardLayoutCommitEvent,
  keyboardRollbackDecisionEvent,
} from "./viewport-geometry";

const traceMilliseconds = 1000;
const header = "ms sy vo vh ih rt rh ct";
export const keyboardInteractionEvent = "weblounge:keyboard-interaction";

export type KeyboardInteractionLabel =
  | "focus:landed"
  | "focus:refused"
  | `focusin:composer(${"no-pointer" | "pointer"})`
  | `pointerdown:composer(${ComposerPointerLanding})`
  | `pointerup:composer(${ComposerPointerLanding})`
  | "touchcancel"
  | `touchend:rejected(${string})`
  | "touchend:tap"
  | "touchstart";

interface KeyboardInteraction {
  readonly at: number;
  readonly label: KeyboardInteractionLabel;
}

type ComposerPointerLanding =
  | "confirmation"
  | "input"
  | "other"
  | "send"
  | "suggestion"
  | "surface";

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
  let rollbacks: readonly string[] = [];
  let interactions: readonly string[] = [];
  let interactionOpen = false;
  let interactionStartedAt = 0;
  let pointerMayFocusComposer = false;
  let trigger = "waiting for tap/focusout";
  let animationFrame = 0;
  const stopSection = installDebugSection(browserWindow, {
    id: "keyboard",
    title: "keyboard",
    read: (): readonly DebugReading[] => [
      ["trigger", trigger],
      ["commits", commits.join(" · ") || "waiting"],
      ["rollbacks", rollbacks.join(" · ") || "waiting"],
      ["interactions", interactions.join(" · ") || "waiting"],
      ["trace", summarizeKeyboardTrace(frames)],
    ],
    subscribe: (render) => {
      const overlay = browserWindow.document.querySelector<HTMLElement>(
        "[data-debug-overlay]",
      );
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
          // Keep the overlay click-through until the input that starts a trace
          // has finished, or it can cover and consume that input on mobile.
          if (overlay !== null) overlay.dataset.debugCopy = "keyboard";
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
        const { geometry, rollbackReason, source } = (
          event as CustomEvent<KeyboardLayoutCommit>
        ).detail;
        const reason =
          rollbackReason === undefined ? "" : `(${rollbackReason})`;
        const state = geometry.keyboard === "open" ? geometry.height : "closed";
        commits = [...commits, `${source}:${state}${reason}`].slice(-5);
        render();
      };
      const recordRollback = (event: Event) => {
        const { outcome, reason } = (
          event as CustomEvent<KeyboardRollbackDecision>
        ).detail;
        rollbacks = [...rollbacks, `${outcome}(${reason})`].slice(-5);
        render();
      };
      const recordInteraction = (event: Event) => {
        const { at, label } = (event as CustomEvent<KeyboardInteraction>)
          .detail;
        const startsInteraction =
          label === "touchstart" || label.startsWith("pointerdown:");
        if (
          (startsInteraction && !interactionOpen) ||
          interactions.length === 0
        ) {
          interactionStartedAt = at;
          interactions = [];
        }
        if (startsInteraction) interactionOpen = true;
        interactions = [
          ...interactions,
          `${compact(at - interactionStartedAt)} ${label}`,
        ].slice(-12);
        if (
          label === "touchcancel" ||
          label.startsWith("touchend:") ||
          label.startsWith("pointerup:")
        )
          interactionOpen = false;
        render();
      };
      const recordComposerFocus = (event: FocusEvent) => {
        if (
          !(event.target instanceof Element) ||
          event.target.closest("[data-composer]") === null
        )
          return;
        reportKeyboardInteraction(
          `focusin:composer(${pointerMayFocusComposer ? "pointer" : "no-pointer"})`,
          browserWindow,
        );
      };
      const recordPointerDown = (event: Event) => {
        const landing = composerPointerLanding(event.target);
        pointerMayFocusComposer = landing !== undefined;
        if (landing !== undefined)
          reportKeyboardInteraction(
            `pointerdown:composer(${landing})`,
            browserWindow,
          );
      };
      const recordPointerUp = (event: Event) => {
        const landing = composerPointerLanding(event.target);
        if (landing !== undefined)
          reportKeyboardInteraction(
            `pointerup:composer(${landing})`,
            browserWindow,
          );
      };
      const clearPointerFocus = () => {
        pointerMayFocusComposer = false;
      };
      browserWindow.addEventListener("pointerdown", recordPointerDown);
      browserWindow.addEventListener("pointerup", record);
      browserWindow.addEventListener("pointerup", recordPointerUp);
      browserWindow.addEventListener("pointerup", clearPointerFocus);
      browserWindow.addEventListener("pointercancel", clearPointerFocus);
      browserWindow.addEventListener("focusout", record);
      browserWindow.addEventListener("focusin", recordComposerFocus);
      browserWindow.addEventListener(keyboardLayoutCommitEvent, recordCommit);
      browserWindow.addEventListener(
        keyboardRollbackDecisionEvent,
        recordRollback,
      );
      browserWindow.addEventListener(
        keyboardInteractionEvent,
        recordInteraction,
      );
      return () => {
        if (animationFrame !== 0)
          browserWindow.cancelAnimationFrame(animationFrame);
        browserWindow.removeEventListener("pointerup", record);
        browserWindow.removeEventListener("pointerdown", recordPointerDown);
        browserWindow.removeEventListener("pointerup", recordPointerUp);
        browserWindow.removeEventListener("pointerup", clearPointerFocus);
        browserWindow.removeEventListener("pointercancel", clearPointerFocus);
        browserWindow.removeEventListener("focusout", record);
        browserWindow.removeEventListener("focusin", recordComposerFocus);
        browserWindow.removeEventListener(
          keyboardLayoutCommitEvent,
          recordCommit,
        );
        browserWindow.removeEventListener(
          keyboardRollbackDecisionEvent,
          recordRollback,
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

function composerPointerLanding(
  target: EventTarget | null,
): ComposerPointerLanding | undefined {
  if (!(target instanceof Element)) return undefined;
  const composer = target.closest("[data-composer]");
  if (composer === null) return undefined;
  if (target.closest("textarea, input") !== null) return "input";
  if (target.closest("[data-composer-send]") !== null) return "send";
  if (target.closest("[role='option']") !== null) return "suggestion";
  if (target.closest("[role='alertdialog']") !== null) return "confirmation";
  if (target === composer || target.closest("[role='combobox']") !== null)
    return "surface";
  return "other";
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
