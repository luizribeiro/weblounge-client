import { describe, expect, it, vi } from "vitest";
import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";
import type {
  EngineClientMessage,
  EngineRequestEnvelope,
  Hello,
  ResyncReason,
  Unsubscribe,
  VisibilityState,
} from "../../engine/protocol";
import type { PushDeviceStore } from "./engine-device-store";
import { PushSynchronizer } from "./push-sync";
import type { RelayClient } from "./relay-client";
import type { PushRouteStore, StoredPushRoute } from "./route-store";

const relayOrigin = "https://push.example.test";
const target = {
  endpoint: "https://fcm.googleapis.com/fcm/send/subscription",
  p256dh: "browser-key",
  auth: "browser-auth",
};

class FakeEngine implements EngineClient {
  readonly requests: EngineRequestEnvelope[] = [];
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();

  start(_hello: Hello): Promise<void> {
    return Promise.resolve();
  }

  send(request: EngineRequestEnvelope) {
    this.requests.push(request);
    return Promise.resolve({ type: "command_result" as const, id: request.id });
  }

  subscribe(listener: (message: EngineClientMessage) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  checkLiveness(): void {}
  requestSnapshot(_reason: ResyncReason): void {}
  setVisibility(_state: VisibilityState): void {}

  emit(message: EngineClientMessage): void {
    for (const listener of this.#listeners) listener(message);
  }
}

class MemoryDevices implements PushDeviceStore {
  credentials: PushDeviceCredentials | undefined;

  load(relay: string): Promise<PushDeviceCredentials | undefined> {
    return Promise.resolve(
      this.credentials?.relay === relay ? this.credentials : undefined,
    );
  }

  store(credentials: PushDeviceCredentials): Promise<void> {
    this.credentials = credentials;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.credentials = undefined;
    return Promise.resolve();
  }
}

class MemoryRoutes implements PushRouteStore {
  readonly values = new Map<number, StoredPushRoute>();

  get(networkId: number): Promise<StoredPushRoute | undefined> {
    return Promise.resolve(this.values.get(networkId));
  }

  put(route: StoredPushRoute): Promise<void> {
    this.values.set(route.networkId, route);
    return Promise.resolve();
  }

  delete(networkId: number): Promise<void> {
    this.values.delete(networkId);
    return Promise.resolve();
  }

  all(): Promise<readonly StoredPushRoute[]> {
    return Promise.resolve([...this.values.values()]);
  }
}

function relay() {
  return {
    createDevice: vi.fn<RelayClient["createDevice"]>(async () => ({
      ok: true as const,
      value: { id: "device-1", secret: "device-secret" },
    })),
    createRoute: vi.fn<RelayClient["createRoute"]>(async () => ({
      ok: true as const,
      value: {
        id: "route-1",
        endpoint: `${relayOrigin}/v1/r/route-1`,
      },
    })),
    activateRoute: vi.fn<RelayClient["activateRoute"]>(async () => ({
      ok: true as const,
      value: null,
    })),
    deleteRoute: vi.fn<RelayClient["deleteRoute"]>(async () => ({
      ok: true as const,
      value: null,
    })),
  } satisfies Pick<
    RelayClient,
    "createDevice" | "createRoute" | "activateRoute" | "deleteRoute"
  >;
}

function fixture(relayApi = relay()) {
  const engine = new FakeEngine();
  const devices = new MemoryDevices();
  const routes = new MemoryRoutes();
  const authorizationRequired = vi.fn();
  const acquireSessionToken = vi.fn(async () => "member-session");
  const synchronizer = new PushSynchronizer({
    engine,
    relay: relayApi,
    relayOrigin,
    target,
    devices,
    routes,
    acquireSessionToken,
    onAuthorizationRequired: authorizationRequired,
    generateRouteKeys: async () => ({
      p256dh: "route-public-key",
      auth: "route-auth",
      privateKey: {} as CryptoKey,
    }),
    exclusive: async (_name, work) => work(),
  });
  return {
    acquireSessionToken,
    authorizationRequired,
    devices,
    engine,
    relay: relayApi,
    routes,
    synchronizer,
  };
}

describe("push state synchronization", () => {
  it("creates one device and route, then activates only after Registered", async () => {
    const current = fixture();
    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();

    expect(current.relay.createDevice).toHaveBeenCalledOnce();
    expect(current.acquireSessionToken).toHaveBeenCalledOnce();
    expect(current.relay.createRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
    );
    expect(current.engine.requests.at(-1)?.request).toEqual({
      type: "register_push",
      network_id: 1,
      route: {
        route_id: "route-1",
        endpoint: `${relayOrigin}/v1/r/route-1`,
        p256dh: "route-public-key",
        auth: "route-auth",
      },
    });
    expect(current.relay.activateRoute).not.toHaveBeenCalled();

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered_but_no_delivery", route_id: "route-1" },
    });
    await current.synchronizer.settled();
    expect(current.relay.activateRoute).not.toHaveBeenCalled();

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered", route_id: "route-1" },
    });
    await current.synchronizer.settled();
    expect(current.relay.activateRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "route-1",
    );

    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();
    expect(current.relay.createDevice).toHaveBeenCalledOnce();
    expect(current.relay.createRoute).toHaveBeenCalledOnce();
    expect(
      current.engine.requests.filter(
        ({ request }) => request.type === "register_push",
      ),
    ).toHaveLength(2);
  });

  it("replaces the route when the home VAPID key changes", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set(1, {
      networkId: 1,
      vapid: "old-vapid",
      routeId: "old-route",
      endpoint: `${relayOrigin}/v1/r/old-route`,
      p256dh: "old-key",
      auth: "old-auth",
      privateKey: {} as CryptoKey,
    });

    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "new-vapid",
      previous_route_id: "old-route",
    });
    await current.synchronizer.settled();

    expect(current.relay.deleteRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "old-route",
    );
    expect(current.relay.createRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "new-vapid",
    );
    expect(current.routes.values.get(1)?.vapid).toBe("new-vapid");
  });

  it("recreates a route that died before activation", async () => {
    const relayApi = relay();
    relayApi.createRoute
      .mockResolvedValueOnce({
        ok: true,
        value: { id: "route-1", endpoint: `${relayOrigin}/v1/r/route-1` },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { id: "route-2", endpoint: `${relayOrigin}/v1/r/route-2` },
      });
    relayApi.activateRoute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "dead_route" },
    });
    const current = fixture(relayApi);
    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();
    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered", route_id: "route-1" },
    });
    await current.synchronizer.settled();

    expect(current.routes.values.get(1)?.routeId).toBe("route-2");
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "register_push",
      route: { route_id: "route-2" },
    });
  });

  it("clears local state and enters reauthorization after a relay 401", async () => {
    const relayApi = relay();
    relayApi.createRoute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "unauthorized" },
    });
    const current = fixture(relayApi);
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "expired-secret",
    };
    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();

    expect(current.devices.credentials).toBeUndefined();
    expect(current.authorizationRequired).toHaveBeenCalledOnce();
    expect(current.engine.requests).toHaveLength(0);
  });

  it("deletes relay routes and durable credentials on sign-out", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set(1, {
      networkId: 1,
      vapid: "home-vapid",
      routeId: "route-1",
      endpoint: `${relayOrigin}/v1/r/route-1`,
      p256dh: "route-key",
      auth: "route-auth",
      privateKey: {} as CryptoKey,
    });

    await current.synchronizer.signOut();

    expect(current.relay.deleteRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "route-1",
    );
    expect(current.routes.values).toHaveLength(0);
    expect(current.devices.credentials).toBeUndefined();
  });
});
