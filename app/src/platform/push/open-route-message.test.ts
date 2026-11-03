import { expect, it } from "vitest";
import { decodeOpenRouteMessage } from "./open-route-message";

it("accepts only service-worker messages with a valid buffer route", () => {
  expect(
    decodeOpenRouteMessage({ kind: "open-route", route: "/Lounge/@mel" }),
  ).toEqual({
    path: "/Lounge/@mel",
    route: { kind: "direct", network: "Lounge", name: "mel" },
  });
  expect(
    decodeOpenRouteMessage({ kind: "open-route", route: "/" }),
  ).toBeUndefined();
  expect(
    decodeOpenRouteMessage({ kind: "other", route: "/Lounge" }),
  ).toBeUndefined();
});
