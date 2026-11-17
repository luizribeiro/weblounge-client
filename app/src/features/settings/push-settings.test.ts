import { describe, expect, it } from "vitest";
import { pushSwitchStatus } from "./push-settings";

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
