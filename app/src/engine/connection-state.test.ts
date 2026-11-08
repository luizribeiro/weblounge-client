import { expect, it } from "vitest";
import {
  connectionPresentation,
  connectionStateKind,
} from "./connection-state";
import type { NetworkProjection } from "./protocol";

it("projects transient and offline states without user-facing connection copy", () => {
  const connecting = network("connecting");
  expect(connectionStateKind(connecting.state)).toBe("connecting");
  expect(connectionPresentation([connecting])).toEqual({
    error: undefined,
    progressing: true,
    sendsBlocked: true,
  });
  expect(connectionPresentation([network("online")])).toEqual({
    error: undefined,
    progressing: false,
    sendsBlocked: false,
  });
  expect(
    connectionPresentation([
      network({ offline: { reason: "device_offline" } }),
    ]),
  ).toEqual({
    error: undefined,
    progressing: true,
    sendsBlocked: true,
  });
  expect(
    connectionPresentation([network({ offline: { reason: "requested" } })]),
  ).toEqual({
    error: undefined,
    progressing: false,
    sendsBlocked: true,
  });
});

it("gives terminal failures one deterministic action", () => {
  expect(
    connectionPresentation([
      network({
        failed: {
          reason: "authentication",
          message_key: "engine.hosted_auth_failed",
        },
      }),
    ]),
  ).toEqual({
    error: {
      action: "sign_in",
      message: "Session expired",
      networkId: 1,
    },
    progressing: false,
    sendsBlocked: true,
  });
});

function network(state: NetworkProjection["state"]): NetworkProjection {
  return { id: 1, label: "Local", nickname: "me", state };
}
