import { expect, it } from "vitest";
import type { NetworkProjection, PushState } from "../../engine/protocol";
import { buildPushDebugSnapshot } from "./push-debug";
import type { PushRouteDiagnostic } from "./push-sync";

it("formats prompt inputs and every typed engine and relay route state", () => {
  const networks = [
    network(1, "Registered"),
    network(2, "Persistence"),
    network(3, "Unsupported"),
    network(4, "Failed"),
  ];
  const engine = new Map<number, PushState>([
    [1, { status: "registered", route_id: "registered-route-secret" }],
    [
      2,
      {
        status: "registered_but_no_delivery",
        route_id: "persistence-route-secret",
      },
    ],
    [3, { status: "unsupported", reason: "no_web_push" }],
    [
      4,
      {
        status: "failed",
        route_id: "failed-route-secret",
        reason: "invalid_parameters",
      },
    ],
  ]);
  const relay = new Map<number, PushRouteDiagnostic>([
    [1, { networkId: 1, state: "active", routeIdPrefix: "register" }],
    [2, { networkId: 2, state: "probing", routeIdPrefix: "persiste" }],
    [3, { networkId: 3, state: "none" }],
    [
      4,
      {
        networkId: 4,
        state: "dead",
        routeIdPrefix: "failed-r",
        lastError: "activate: dead_route",
      },
    ],
  ]);

  const snapshot = buildPushDebugSnapshot(
    {
      configured: true,
      supported: true,
      permission: "granted",
      dismissed: false,
      ios: false,
      display: "browser",
    },
    networks,
    engine,
    relay,
  );

  expect(snapshot.readings).toEqual([
    [
      "prompt",
      "configured=true / supported=true / permission=granted / dismissed=false / ios=false / display=browser",
    ],
    [
      "network Registered",
      "engine=Registered (register) / relay=active (register) / last error=none",
    ],
    [
      "network Persistence",
      "engine=RegisteredButNoDelivery (persiste) / relay=probing (persiste) / last error=none",
    ],
    [
      "network Unsupported",
      "engine=Unsupported(no_web_push) / relay=none / last error=none",
    ],
    [
      "network Failed",
      "engine=Failed(invalid_parameters) / relay=dead (failed-r) / last error=activate: dead_route",
    ],
  ]);
  expect(snapshot.summary).not.toContain("registered-route-secret");
  expect(snapshot.summary).not.toContain("persistence-route-secret");
});

function network(id: number, label: string): NetworkProjection {
  return { id, label, nickname: "weblounge", state: "online" };
}
