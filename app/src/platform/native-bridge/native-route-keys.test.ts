import { describe, expect, it } from "vitest";
import type {
  PushRouteRecord,
  PushRouteStore,
  StoredPushRoute,
} from "../push/route-store";
import type { NativeBridge } from "./native-bridge";
import {
  NativeKeyedRouteStore,
  nativeRouteKeyFactory,
} from "./native-route-keys";

function recordingBridge(failing?: string) {
  const calls: [string, unknown][] = [];
  const bridge = {
    call: async (command: string, request?: unknown) => {
      calls.push([command, request]);
      if (command === failing)
        throw { kind: "keychain", message: "item locked" };
      return command === "create_route_keys"
        ? { p256dh: "keychain-public-key", auth: "keychain-auth" }
        : null;
    },
  } as NativeBridge;
  return { bridge, calls };
}

class MemoryRoutes implements PushRouteStore {
  readonly values = new Map<string, PushRouteRecord>();
  async get(vapid: string) {
    return this.values.get(vapid);
  }
  async findRoute(routeId: string) {
    return [...this.values.values()].find((route) => route.routeId === routeId);
  }
  async put(route: StoredPushRoute) {
    this.values.set(route.vapid, route);
  }
  async delete(vapid: string) {
    this.values.delete(vapid);
  }
  async all() {
    return [...this.values.values()];
  }
}

function route(overrides: Partial<PushRouteRecord> = {}): StoredPushRoute {
  return {
    networkId: 1,
    networkLabel: "Lounge",
    nickname: "me",
    vapid: "home-vapid",
    routeId: "route-1",
    endpoint: "https://push.example.test/v1/r/route-1",
    p256dh: "keychain-public-key",
    auth: "keychain-auth",
    keyStorage: "native",
    ...overrides,
  } as StoredPushRoute;
}

describe("native route keys", () => {
  it("creates a route's keys in the shell with the route's metadata", async () => {
    const { bridge, calls } = recordingBridge();

    await expect(
      nativeRouteKeyFactory(bridge)({
        routeId: "route-1",
        networkId: 1,
        networkLabel: "Lounge",
        nickname: "me",
      }),
    ).resolves.toEqual({
      p256dh: "keychain-public-key",
      auth: "keychain-auth",
      keyStorage: "native",
    });
    expect(calls).toEqual([
      [
        "create_route_keys",
        {
          routeId: "route-1",
          route: { networkId: 1, networkLabel: "Lounge", nickname: "me" },
        },
      ],
    ]);
  });

  it("drops the keys of a deleted route or one replaced by a new route", async () => {
    const { bridge, calls } = recordingBridge();
    const store = new NativeKeyedRouteStore(new MemoryRoutes(), bridge);

    await store.put(route());
    await store.put(route({ active: true }));
    await store.put(route({ routeId: "route-2" }));
    await store.delete("home-vapid");
    await store.delete("home-vapid");

    expect(calls).toEqual([
      ["drop_route_keys", { routeId: "route-1" }],
      ["drop_route_keys", { routeId: "route-2" }],
    ]);
  });

  it("leaves routes whose keys the page holds to the page", async () => {
    const { bridge, calls } = recordingBridge();
    const records = new MemoryRoutes();
    const store = new NativeKeyedRouteStore(records, bridge);

    await store.put(
      route({ keyStorage: undefined, privateKeyPkcs8: Uint8Array.of(1) }),
    );
    await store.delete("home-vapid");

    expect(calls).toEqual([]);
    expect(records.values.size).toBe(0);
  });

  it("forgets the record even when the keychain refuses the drop", async () => {
    const { bridge, calls } = recordingBridge("drop_route_keys");
    const records = new MemoryRoutes();
    const store = new NativeKeyedRouteStore(records, bridge);
    await store.put(route());

    await expect(store.delete("home-vapid")).resolves.toBeUndefined();
    expect(records.values.size).toBe(0);
    expect(calls).toEqual([["drop_route_keys", { routeId: "route-1" }]]);
  });
});
