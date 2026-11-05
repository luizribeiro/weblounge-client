import { expect, it } from "vitest";
import { decodeOpenRouteMessage } from "./open-route-message";

it("accepts only service-worker messages with a valid buffer route", () => {
  expect(
    decodeOpenRouteMessage({
      kind: "open-route",
      route: "/Lounge/@mel",
      intentId: "intent-1",
    }),
  ).toEqual({
    path: "/Lounge/@mel",
    route: { kind: "direct", network: "Lounge", name: "mel" },
    intentId: "intent-1",
  });
  expect(
    decodeOpenRouteMessage({ kind: "open-route", route: "/" }),
  ).toBeUndefined();
  expect(
    decodeOpenRouteMessage({ kind: "other", route: "/Lounge" }),
  ).toBeUndefined();
  expect(
    decodeOpenRouteMessage({
      kind: "open-route",
      route: "/Lounge/@mel",
      intentId: 1,
    }),
  ).toBeUndefined();
});
