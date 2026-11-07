import { expect, it } from "vitest";
import { decodePushSyncMessage } from "./push-sync-channel";

it("accepts typed cross-tab subscription refreshes", () => {
  expect(
    decodePushSyncMessage({
      kind: "refresh",
      target: {
        endpoint: "https://push.example.test/subscription",
        p256dh: "browser-key",
        auth: "browser-auth",
      },
    }),
  ).toEqual({
    kind: "refresh",
    target: {
      endpoint: "https://push.example.test/subscription",
      p256dh: "browser-key",
      auth: "browser-auth",
    },
  });
});

it("rejects malformed cross-tab push credentials", () => {
  expect(
    decodePushSyncMessage({
      kind: "device",
      device: { id: "device-1" },
    }),
  ).toBeUndefined();
});
