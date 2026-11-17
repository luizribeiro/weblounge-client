import { describe, expect, it } from "vitest";
import {
  type PushSettings,
  pushBlockedIn,
  pushNote,
  pushSwitchChecked,
  pushSwitchStatus,
} from "./push-settings";

const settings = (overrides: Partial<PushSettings>): PushSettings => ({
  status: "on",
  blockedIn: "ios",
  onToggle: () => {},
  onRetry: () => {},
  onOpenSystemSettings: undefined,
  ...overrides,
});

describe("push switch row", () => {
  it("reads on while chosen, even while failing, and waits for settings", () => {
    expect(pushSwitchChecked("on")).toBe(true);
    expect(pushSwitchChecked("failed")).toBe(true);
    expect(pushSwitchChecked("off")).toBe(false);
    expect(pushSwitchChecked("blocked")).toBe(false);
    expect(pushSwitchChecked(undefined)).toBeUndefined();
  });

  it("notes a block, with Open Settings only when the shell can", () => {
    expect(pushNote(settings({ status: "blocked" }))).toEqual({
      kind: "blocked",
      in: "ios",
      openSettings: false,
    });
    expect(
      pushNote(settings({ status: "blocked", onOpenSystemSettings: () => {} })),
    ).toEqual({ kind: "blocked", in: "ios", openSettings: true });
  });

  it("notes a failure and nothing otherwise", () => {
    expect(pushNote(settings({ status: "failed" }))).toEqual({
      kind: "failed",
    });
    expect(pushNote(settings({ status: "on" }))).toBeUndefined();
    expect(pushNote(settings({ status: "off" }))).toBeUndefined();
  });

  it("names where notifications are unblocked on each host", () => {
    expect(pushBlockedIn("macos-app", false)).toBe("macos");
    expect(pushBlockedIn("ios-app", true)).toBe("ios");
    expect(pushBlockedIn("web", true)).toBe("ios");
    expect(pushBlockedIn("web", false)).toBe("browser");
  });
});

describe("push switch status", () => {
  it.each([
    ["blocked before settings load", undefined, "denied", false, "blocked"],
    ["blocked even when chosen on", true, "denied", false, "blocked"],
    ["unknown until settings load", undefined, "granted", false, undefined],
    ["off before anyone asked", true, "default", false, "off"],
    ["off before anyone asked, whatever failed", true, "default", true, "off"],
    [
      "unknown before load when never asked",
      undefined,
      "default",
      false,
      undefined,
    ],
    ["off when turned off", false, "granted", false, "off"],
    ["off when turned off while failing", false, "granted", true, "off"],
    ["on when chosen and granted", true, "granted", false, "on"],
    ["failed when registration keeps failing", true, "granted", true, "failed"],
  ] as const)("is %s", (_name, enabled, permission, failing, status) => {
    expect(pushSwitchStatus({ enabled, permission, failing })).toBe(status);
  });
});
