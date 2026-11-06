import { describe, expect, it, vi } from "vitest";
import {
  ForegroundLog,
  type ForegroundLogEntry,
  ForegroundRecorder,
  type ForegroundSnapshot,
} from "./foreground-log";

const visible: ForegroundSnapshot = {
  visibility: "visible",
  hasFocus: true,
  hidden: false,
  navigatorStandalone: null,
  displayModeStandalone: false,
  foreground: true,
};

describe("foreground log ring", () => {
  it("retains only the newest entries in newest-first order", () => {
    const log = new ForegroundLog(2);
    const subscriber = vi.fn();
    const unsubscribe = log.subscribe(subscriber);

    log.append(entry(1));
    log.append(entry(2));
    log.append(entry(3));

    expect(log.newestFirst().map(({ monotonicMs }) => monotonicMs)).toEqual([
      3, 2,
    ]);
    expect(subscriber).toHaveBeenCalledTimes(3);
    unsubscribe();
    log.append(entry(4));
    expect(subscriber).toHaveBeenCalledTimes(3);
  });
});

describe("foreground recorder", () => {
  it("records fake lifecycle events, transitions, and lease results", () => {
    const log = new ForegroundLog();
    const pageDocument = new EventTarget();
    const browserWindow = new EventTarget();
    let snapshot = visible;
    let monotonicMs = 10;
    let wallTimeMs = 1_700_000_000_000;
    const recorder = new ForegroundRecorder(
      log,
      () => snapshot,
      () => monotonicMs++,
      () => wallTimeMs++,
    );
    const stop = recorder.install(pageDocument, browserWindow);

    pageDocument.dispatchEvent(new Event("visibilitychange"));
    browserWindow.dispatchEvent(new Event("focus"));
    browserWindow.dispatchEvent(new Event("blur"));
    browserWindow.dispatchEvent(new Event("pageshow"));
    browserWindow.dispatchEvent(new Event("pagehide"));
    pageDocument.dispatchEvent(new Event("freeze"));
    pageDocument.dispatchEvent(new Event("resume"));
    snapshot = { ...visible, foreground: false, hasFocus: false };
    recorder.recordForegroundTransition(false);
    recorder.recordForegroundTransition(false);
    recorder.recordLease("acquire", "sent");
    recorder.recordLease("acquire", "ok");
    recorder.recordLease("renew", "sent");
    recorder.recordLease("renew", "unavailable");
    recorder.recordReleaseBeacon();
    stop();
    browserWindow.dispatchEvent(new Event("focus"));

    const entries = log.newestFirst();
    expect(entries).toHaveLength(13);
    expect(entries[0]?.event).toEqual({ type: "lease_release_beacon" });
    expect(entries[1]?.event).toEqual({
      type: "lease",
      action: "renew",
      result: "unavailable",
    });
    expect(entries[5]?.event).toEqual({
      type: "transition",
      foreground: false,
      snapshot,
    });
    expect(
      entries
        .filter(({ event }) => event.type === "lifecycle")
        .map(({ event }) => (event.type === "lifecycle" ? event.kind : null))
        .reverse(),
    ).toEqual([
      "visibilitychange",
      "focus",
      "blur",
      "pageshow",
      "pagehide",
      "freeze",
      "resume",
    ]);
    expect(entries.at(-1)).toMatchObject({
      monotonicMs: 10,
      wallTimeMs: 1_700_000_000_000,
    });
  });
});

function entry(monotonicMs: number): ForegroundLogEntry {
  return {
    monotonicMs,
    wallTimeMs: monotonicMs,
    event: { type: "transition", foreground: true, snapshot: visible },
  };
}
