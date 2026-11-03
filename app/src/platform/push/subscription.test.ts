import { describe, expect, it, vi } from "vitest";
import { decodeBase64Url } from "./base64url";
import { ensurePushSubscription } from "./subscription";

const relayVapid =
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";

function subscription(
  applicationServerKey: ArrayBuffer | null,
): PushSubscription {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
    expirationTime: null,
    options: { applicationServerKey, userVisibleOnly: true },
    getKey: (name) =>
      name === "p256dh"
        ? Uint8Array.from([1, 2, 3]).buffer
        : Uint8Array.from([4, 5]).buffer,
    toJSON: () => ({}),
    unsubscribe: vi.fn(async () => true),
  };
}

function registration(
  manager: Partial<PushManager>,
): ServiceWorkerRegistration {
  return { pushManager: manager } as ServiceWorkerRegistration;
}

describe("push subscription", () => {
  it("does nothing until notification permission is already granted", async () => {
    const subscribe = vi.fn();
    const result = await ensurePushSubscription(
      registration({ subscribe }),
      relayVapid,
      "default",
    );

    expect(result).toEqual({ status: "permission_not_granted" });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("subscribes with the configured relay VAPID key", async () => {
    const created = subscription(decodeBase64Url(relayVapid).buffer);
    const subscribe = vi.fn(async () => created);
    const result = await ensurePushSubscription(
      registration({ getSubscription: vi.fn(async () => null), subscribe }),
      relayVapid,
      "granted",
    );

    expect(subscribe).toHaveBeenCalledWith({
      applicationServerKey: decodeBase64Url(relayVapid),
      userVisibleOnly: true,
    });
    expect(result).toEqual({
      status: "ready",
      target: {
        endpoint: created.endpoint,
        p256dh: "AQID",
        auth: "BAU",
      },
    });
  });

  it("replaces a subscription pinned to an old relay VAPID key", async () => {
    const old = subscription(Uint8Array.from([4, 1]).buffer);
    const current = subscription(decodeBase64Url(relayVapid).buffer);
    const subscribe = vi.fn(async () => current);

    await ensurePushSubscription(
      registration({ getSubscription: vi.fn(async () => old), subscribe }),
      relayVapid,
      "granted",
    );

    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
