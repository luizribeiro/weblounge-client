import { describe, expect, it, vi } from "vitest";
import type { PushTarget } from "../native-bridge/generated/PushTarget";
import {
  isDeviceTarget,
  relayTargetBody,
  sameDeviceTarget,
} from "./device-target";
import { decodePushSyncMessage } from "./push-sync-channel";
import { RelayClient } from "./relay-client";

const browser = {
  endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
  p256dh: "browser-key",
  auth: "browser-auth",
};
const iphone: PushTarget = {
  platform: "apns",
  token: "ab".repeat(32),
  environment: "production",
};

describe("device targets", () => {
  it("sends a browser subscription as web_push and an APNs token as itself", () => {
    expect(relayTargetBody(browser)).toEqual({
      platform: "web_push",
      ...browser,
    });
    expect(relayTargetBody(iphone)).toEqual({
      platform: "apns",
      token: "ab".repeat(32),
      environment: "production",
    });
  });

  it("registers an iPhone's APNs token at the relay", async () => {
    const fetchRelay = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: "device-1", secret: "secret" }, { status: 201 }),
      );

    await new RelayClient("https://push.example.test", fetchRelay).createDevice(
      "member-session",
      iphone,
    );

    expect(fetchRelay).toHaveBeenCalledWith(
      "https://push.example.test/v1/devices",
      expect.objectContaining({
        body: JSON.stringify({ target: iphone }),
      }),
    );
  });

  it("treats a rotated token, another environment or another platform as a new target", () => {
    expect(sameDeviceTarget(iphone, { ...iphone })).toBe(true);
    expect(
      sameDeviceTarget(iphone, { ...iphone, token: "cd".repeat(32) }),
    ).toBe(false);
    expect(
      sameDeviceTarget(iphone, { ...iphone, environment: "sandbox" }),
    ).toBe(false);
    expect(sameDeviceTarget(browser, iphone)).toBe(false);
    expect(sameDeviceTarget(iphone, browser)).toBe(false);
    expect(sameDeviceTarget(browser, { ...browser })).toBe(true);
    expect(sameDeviceTarget(undefined, browser)).toBe(false);
  });

  it("accepts both platforms across tabs and rejects malformed targets", () => {
    expect(isDeviceTarget(browser)).toBe(true);
    expect(isDeviceTarget(iphone)).toBe(true);
    expect(isDeviceTarget({ ...iphone, environment: "staging" })).toBe(false);
    expect(isDeviceTarget({ platform: "fcm", token: "t" })).toBe(false);
    expect(isDeviceTarget({ ...iphone, token: "" })).toBe(false);
    expect(isDeviceTarget({ endpoint: "e" })).toBe(false);
    expect(decodePushSyncMessage({ kind: "refresh", target: iphone })).toEqual({
      kind: "refresh",
      target: iphone,
    });
  });
});
