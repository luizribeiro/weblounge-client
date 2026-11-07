import { expect, it } from "vitest";
import { decodePushSyncMessage } from "./push-sync-channel";

it("accepts typed cross-tab push events", () => {
  expect(
    decodePushSyncMessage({
      kind: "event",
      event: {
        type: "push_route_required",
        network_id: 7,
        vapid: "home-vapid",
        previous_route_id: null,
      },
    }),
  ).toEqual({
    kind: "event",
    event: {
      type: "push_route_required",
      network_id: 7,
      vapid: "home-vapid",
      previous_route_id: null,
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
