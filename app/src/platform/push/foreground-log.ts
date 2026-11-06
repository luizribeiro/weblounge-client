import { pageIsForeground } from "./foreground-state";
import type { RelayFailure } from "./relay-client";

const displayModeStandalone = "(display-mode: standalone)";

export interface ForegroundSnapshot {
  readonly visibility: "hidden" | "prerender" | "unknown" | "visible";
  readonly hasFocus: boolean;
  readonly hidden: boolean;
  readonly navigatorStandalone: boolean | null;
  readonly displayModeStandalone: boolean;
  readonly foreground: boolean;
}

type LifecycleKind =
  | "blur"
  | "focus"
  | "freeze"
  | "pagehide"
  | "pageshow"
  | "resume"
  | "visibilitychange";

export type ForegroundLogEvent =
  | {
      readonly type: "lifecycle";
      readonly kind: LifecycleKind;
      readonly snapshot: ForegroundSnapshot;
    }
  | {
      readonly type: "transition";
      readonly foreground: boolean;
      readonly snapshot: ForegroundSnapshot;
    }
  | {
      readonly type: "lease";
      readonly action: "acquire" | "renew";
      readonly result: "sent" | "ok" | RelayFailure["kind"];
    }
  | { readonly type: "lease_release_beacon" };

export interface ForegroundLogEntry {
  readonly monotonicMs: number;
  readonly wallTimeMs: number;
  readonly event: ForegroundLogEvent;
}

export class ForegroundLog {
  readonly #entries: Array<ForegroundLogEntry | undefined>;
  readonly #subscribers = new Set<() => void>();
  #next = 0;
  #size = 0;

  constructor(capacity = 200) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("foreground log capacity must be positive");
    this.#entries = Array.from({ length: capacity });
  }

  append(entry: ForegroundLogEntry): void {
    this.#entries[this.#next] = entry;
    this.#next = (this.#next + 1) % this.#entries.length;
    this.#size = Math.min(this.#size + 1, this.#entries.length);
    for (const subscriber of this.#subscribers) subscriber();
  }

  newestFirst(): readonly ForegroundLogEntry[] {
    return Array.from({ length: this.#size }, (_, index) => {
      const position =
        (this.#next - index - 1 + this.#entries.length) % this.#entries.length;
      return this.#entries[position] as ForegroundLogEntry;
    });
  }

  subscribe(subscriber: () => void): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }
}

export class ForegroundRecorder {
  readonly #log: ForegroundLog;
  readonly #snapshot: () => ForegroundSnapshot;
  readonly #monotonicNow: () => number;
  readonly #wallNow: () => number;
  #lastForeground: boolean | undefined;

  constructor(
    log: ForegroundLog,
    snapshot: () => ForegroundSnapshot,
    monotonicNow: () => number = () => performance.now(),
    wallNow: () => number = () => Date.now(),
  ) {
    this.#log = log;
    this.#snapshot = snapshot;
    this.#monotonicNow = monotonicNow;
    this.#wallNow = wallNow;
  }

  install(pageDocument: EventTarget, browserWindow: EventTarget): () => void {
    const registrations = [
      [pageDocument, "visibilitychange"],
      [browserWindow, "focus"],
      [browserWindow, "blur"],
      [browserWindow, "pageshow"],
      [browserWindow, "pagehide"],
      [pageDocument, "freeze"],
      [pageDocument, "resume"],
    ] as const;
    const listeners = registrations.map(([target, kind]) => {
      const listener = () =>
        this.#record({
          type: "lifecycle",
          kind,
          snapshot: this.#snapshot(),
        });
      target.addEventListener(kind, listener);
      return [target, kind, listener] as const;
    });
    return () => {
      for (const [target, kind, listener] of listeners)
        target.removeEventListener(kind, listener);
    };
  }

  recordForegroundTransition(foreground: boolean): void {
    if (this.#lastForeground === foreground) return;
    this.#lastForeground = foreground;
    this.#record({
      type: "transition",
      foreground,
      snapshot: this.#snapshot(),
    });
  }

  recordLease(
    action: "acquire" | "renew",
    result: "sent" | "ok" | RelayFailure["kind"],
  ): void {
    this.#record({ type: "lease", action, result });
  }

  recordReleaseBeacon(): void {
    this.#record({ type: "lease_release_beacon" });
  }

  #record(event: ForegroundLogEvent): void {
    this.#log.append({
      monotonicMs: this.#monotonicNow(),
      wallTimeMs: this.#wallNow(),
      event,
    });
  }
}

export const foregroundLog = new ForegroundLog();

export function formatForegroundLog(
  entries: readonly ForegroundLogEntry[],
): string {
  const newest = entries[0]?.monotonicMs;
  if (newest === undefined) return "No foreground activity recorded.";
  return entries
    .map((entry) => {
      const relative = `-${((newest - entry.monotonicMs) / 1_000).toFixed(3)}s`;
      const timestamp = new Date(entry.wallTimeMs).toISOString();
      return `${relative} ${timestamp} mono=${entry.monotonicMs.toFixed(1)}ms ${formatEvent(entry.event)}`;
    })
    .join("\n");
}

export function readForegroundSnapshot(
  pageDocument: Document,
  browserNavigator: Navigator,
  browserWindow: Window,
): ForegroundSnapshot {
  const standalone = Reflect.get(browserNavigator, "standalone");
  return {
    visibility: visibility(pageDocument.visibilityState),
    hasFocus: pageDocument.hasFocus(),
    hidden: pageDocument.hidden,
    navigatorStandalone: typeof standalone === "boolean" ? standalone : null,
    displayModeStandalone: matchesStandalone(browserWindow),
    foreground: pageIsForeground(pageDocument, browserNavigator),
  };
}

function visibility(value: string): ForegroundSnapshot["visibility"] {
  if (value === "hidden" || value === "prerender" || value === "visible")
    return value;
  return "unknown";
}

function matchesStandalone(browserWindow: Window): boolean {
  try {
    return browserWindow.matchMedia(displayModeStandalone).matches;
  } catch {
    return false;
  }
}

function formatEvent(event: ForegroundLogEvent): string {
  switch (event.type) {
    case "lifecycle":
      return `${event.kind} ${formatSnapshot(event.snapshot)}`;
    case "transition":
      return `foreground -> ${event.foreground} ${formatSnapshot(event.snapshot)}`;
    case "lease":
      return `lease ${event.action} ${event.result === "ok" || event.result === "sent" ? event.result : `error=${event.result}`}`;
    case "lease_release_beacon":
      return "lease release beacon sent";
  }
}

function formatSnapshot(snapshot: ForegroundSnapshot): string {
  return [
    `visibility=${snapshot.visibility}`,
    `focus=${snapshot.hasFocus}`,
    `hidden=${snapshot.hidden}`,
    `navigator-standalone=${snapshot.navigatorStandalone ?? "absent"}`,
    `display-standalone=${snapshot.displayModeStandalone}`,
    `derived=${snapshot.foreground}`,
  ].join(" ");
}
