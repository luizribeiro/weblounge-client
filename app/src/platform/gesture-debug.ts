import { type DebugReading, installDebugSection } from "./debug-overlay";

export interface GestureReleaseDebug {
  readonly averageVelocity: number;
  readonly distance: number;
  readonly releaseVelocity: number;
}

export interface GestureDebugHandle {
  claim(deltaX: number, deltaY: number, time: number): void;
  rejectAngle(): void;
  up(committed: boolean, release: GestureReleaseDebug): void;
  pointerCancel(deltaX: number, deltaY: number, time: number): void;
  lostCapture(): void;
  reset(reason: "visibility" | "popstate"): void;
}

interface GestureRecord {
  readonly start: string;
  lock: string;
  end?: string;
  claimedAt?: number;
}

const limit = 5;
const records: GestureRecord[] = [];
const subscribers = new Set<() => void>();

export function beginGestureDebug(
  region: string,
  event: PointerEvent,
): GestureDebugHandle {
  const record: GestureRecord = {
    start: `${round(event.clientX)},${round(event.clientY)} ${region}`,
    lock: "never-locked",
  };
  records.unshift(record);
  records.splice(limit);
  publish();
  const finish = (end: string) => {
    record.end = end;
    publish();
  };
  return {
    claim(deltaX, deltaY, time) {
      record.claimedAt = time;
      record.lock = `horizontal@${round(deltaX)},${round(deltaY)}`;
      publish();
    },
    rejectAngle() {
      record.lock = "rejected-angle";
      publish();
    },
    up(committed, release) {
      finish(
        `up-${committed ? "commit" : "cancel"} d=${round(release.distance)}` +
          ` avg=${speed(release.averageVelocity)}` +
          ` release=${speed(release.releaseVelocity)}`,
      );
    },
    pointerCancel(deltaX, deltaY, time) {
      finish(
        `pointercancel dx=${round(deltaX)} dy=${round(deltaY)}` +
          ` claim+${round(time - (record.claimedAt ?? time))}ms`,
      );
    },
    lostCapture() {
      finish("lostcapture");
    },
    reset(reason) {
      finish(`reset:${reason}`);
    },
  };
}

export function recordGestureNotStarted(
  region: string,
  event: PointerEvent,
  reason: string,
): void {
  records.unshift({
    end: `not-started:${reason}`,
    lock: "never-locked",
    start: `${round(event.clientX)},${round(event.clientY)} ${region}`,
  });
  records.splice(limit);
  publish();
}

export function installGestureDebug(
  root: HTMLElement,
  browserWindow: Window,
): () => void {
  return installDebugSection(browserWindow, {
    id: "gestures",
    title: "gestures",
    read: () => readGestureDiagnostics(root),
    subscribe: (render) => {
      const keyboard = new MutationObserver(render);
      keyboard.observe(root, {
        attributeFilter: ["data-keyboard"],
        attributes: true,
      });
      subscribers.add(render);
      return () => {
        keyboard.disconnect();
        subscribers.delete(render);
      };
    },
  });
}

export function readGestureDiagnostics(
  root: HTMLElement,
): readonly DebugReading[] {
  return [
    ["data-keyboard", root.dataset.keyboard ?? "unset"],
    ...records.map(
      (record, index): DebugReading => [
        String(index + 1),
        `${record.start} | ${record.lock} | ${record.end ?? "active"}`,
      ],
    ),
  ];
}

export function clearGestureDiagnostics(): void {
  records.splice(0);
  publish();
}

function publish(): void {
  for (const subscriber of subscribers) subscriber();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function speed(value: number): string {
  return round(value).toFixed(1);
}
