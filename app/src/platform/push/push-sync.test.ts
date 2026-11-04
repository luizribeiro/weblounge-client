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
  readonly operations: string[] = [];
  failUnregister = false;
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();

  start(_hello: Hello): Promise<void> {
    return Promise.resolve();
  }

  send(request: EngineRequestEnvelope) {
    this.requests.push(request);
    this.operations.push(request.request.type);
    if (
      (request.request.type === "unregister_push" ||
        request.request.type === "unregister_push_route") &&
      this.failUnregister
    ) {
      this.emit({
        type: "push_state_changed",
        network_id: request.request.network_id,
        state: {
          status: "failed",
          route_id:
            request.request.type === "unregister_push_route"
              ? request.request.route_id
              : "current-route",
          reason: "connection",
        },
      });
      return Promise.reject(new Error("unregister failed"));
    }
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
  readonly values = new Map<string, StoredPushRoute>();

  get(routeId: string): Promise<StoredPushRoute | undefined> {
    return Promise.resolve(this.values.get(routeId));
  }

  put(route: StoredPushRoute): Promise<void> {
    this.values.set(route.routeId, route);
    return Promise.resolve();
  }

  delete(routeId: string): Promise<void> {
    this.values.delete(routeId);
    return Promise.resolve();
  }

  all(): Promise<readonly StoredPushRoute[]> {
    return Promise.resolve([...this.values.values()]);
  }
}

function relay() {
  let routeSequence = 0;
  return {
    createDevice: vi.fn<RelayClient["createDevice"]>(async () => ({
      ok: true as const,
      value: { id: "device-1", secret: "device-secret" },
    })),
    createRoute: vi.fn<RelayClient["createRoute"]>(async () => {
      routeSequence += 1;
      const id = `route-${routeSequence}`;
      return {
        ok: true as const,
        value: { id, endpoint: `${relayOrigin}/v1/r/${id}` },
      };
    }),
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

function statefulRelay(
  initialRoutes: readonly string[],
  deleteFailures: readonly ("unavailable" | "unauthorized")[],
) {
  const routes = new Map<string, "probing" | "active">(
    initialRoutes.map((routeId) => [routeId, "active" as const]),
  );
  let routeSequence = 0;
  const failures = [...deleteFailures];
  return {
    routes,
    createDevice: vi.fn<RelayClient["createDevice"]>(async () => ({
      ok: true as const,
      value: { id: "new-device", secret: "new-secret" },
    })),
    createRoute: vi.fn<RelayClient["createRoute"]>(async () => {
      routeSequence += 1;
      const id = `new-route-${routeSequence}`;
      routes.set(id, "probing");
      return {
        ok: true as const,
        value: { id, endpoint: `${relayOrigin}/v1/r/${id}` },
      };
    }),
    activateRoute: vi.fn<RelayClient["activateRoute"]>(
      async (_device, routeId) => {
        routes.set(routeId, "active");
        return { ok: true as const, value: null };
      },
    ),
    deleteRoute: vi.fn<RelayClient["deleteRoute"]>(async (_device, routeId) => {
      const failure = failures.shift();
      if (failure !== undefined) {
        return { ok: false as const, error: { kind: failure } };
      }
      routes.delete(routeId);
      return { ok: true as const, value: null };
    }),
  };
}

function fixture(relayApi = relay()) {
  const engine = new FakeEngine();
  const devices = new MemoryDevices();
  const routes = new MemoryRoutes();
  const authorizationRequired = vi.fn();
  const routeDiagnostic = vi.fn();
  const acquireSessionToken = vi.fn(async () => "member-session");
  const synchronizer = new PushSynchronizer({
    engine,
    relay: relayApi,
    relayOrigin,
    target,
    routeContext: () => ({ networkLabel: "Lounge", nickname: "weblounge" }),
    devices,
    routes,
    acquireSessionToken,
    onAuthorizationRequired: authorizationRequired,
    onRouteDiagnostic: routeDiagnostic,
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
    routeDiagnostic,
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
    expect(current.routeDiagnostic).toHaveBeenLastCalledWith({
      networkId: 1,
      state: "probing",
      routeIdPrefix: "route-1",
    });

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
    expect(current.routeDiagnostic).toHaveBeenLastCalledWith({
      networkId: 1,
      state: "active",
      routeIdPrefix: "route-1",
    });

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
    current.routes.values.set("old-route", {
      networkId: 1,
      networkLabel: "Lounge",
      nickname: "weblounge",
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
    current.relay.deleteRoute.mockImplementationOnce(async () => {
      current.engine.operations.push("delete_route");
      return { ok: true, value: null };
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
    expect(current.routes.values.get("route-1")?.vapid).toBe("new-vapid");
    expect(current.engine.operations).toEqual([
      "unregister_push_route",
      "delete_route",
      "register_push",
    ]);
  });

  it("reuses an active route migrated from the previous build", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("migrated-route", {
      networkId: 41,
      networkLabel: "Lounge",
      nickname: "weblounge",
      vapid: "home-vapid",
      routeId: "migrated-route",
      endpoint: `${relayOrigin}/v1/r/migrated-route`,
      p256dh: "old-key",
      auth: "old-auth",
      privateKey: {} as CryptoKey,
    });

    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();

    expect(current.relay.createRoute).not.toHaveBeenCalled();
    expect(current.relay.deleteRoute).not.toHaveBeenCalled();
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "register_push",
      network_id: 1,
      route: { route_id: "migrated-route" },
    });
    expect(current.routes.values.get("migrated-route")).toMatchObject({
      networkId: 1,
      deviceId: "device-1",
    });
  });

  it("unregisters every stale home endpoint and converges six routes to one", async () => {
    const routeIds = Array.from(
      { length: 6 },
      (_, index) => `route-${index + 1}`,
    );
    const relayApi = statefulRelay(routeIds, []);
    const current = fixture(relayApi);
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    for (const routeId of routeIds) {
      current.routes.values.set(routeId, {
        networkId: 1,
        networkLabel: "Lounge",
        nickname: "weblounge",
        vapid: "home-vapid",
        routeId,
        deviceId: "device-1",
        endpoint: `${relayOrigin}/v1/r/${routeId}`,
        p256dh: `${routeId}-key`,
        auth: `${routeId}-auth`,
        privateKey: {} as CryptoKey,
      });
    }

    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: "route-6",
    });
    await current.synchronizer.settled();

    expect(current.engine.requests.map(({ request }) => request)).toEqual([
      ...routeIds.slice(0, 5).map((routeId) => ({
        type: "unregister_push_route",
        network_id: 1,
        route_id: routeId,
        endpoint: `${relayOrigin}/v1/r/${routeId}`,
      })),
      expect.objectContaining({
        type: "register_push",
        network_id: 1,
        route: expect.objectContaining({ route_id: "route-6" }),
      }),
    ]);
    expect(
      relayApi.deleteRoute.mock.calls.map(([, routeId]) => routeId),
    ).toEqual(routeIds.slice(0, 5));
    expect(relayApi.routes).toEqual(new Map([["route-6", "active"]]));
    expect([...current.routes.values.keys()]).toEqual(["route-6"]);
    expect(current.relay.createRoute).not.toHaveBeenCalled();
  });

  it("replaces a refused dead route once and retries again on reconnect", async () => {
    const current = fixture();
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
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "invalid_parameters",
      },
    });
    await current.synchronizer.settled();

    expect(current.relay.deleteRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "route-1",
    );
    expect(
      current.engine.requests.slice(-2).map(({ request }) => request.type),
    ).toEqual(["unregister_push_route", "register_push"]);
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "register_push",
      route: { route_id: "route-2" },
    });
    expect(current.routeDiagnostic).toHaveBeenLastCalledWith({
      networkId: 1,
      state: "probing",
      routeIdPrefix: "route-2",
      lastError: "engine: invalid_parameters",
    });

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-2",
        reason: "invalid_parameters",
      },
    });
    await current.synchronizer.settled();
    expect(current.relay.createRoute).toHaveBeenCalledTimes(2);
    expect(current.routeDiagnostic).toHaveBeenLastCalledWith({
      networkId: 1,
      state: "none",
      lastError: "engine: invalid_parameters",
    });

    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "register_push",
      route: { route_id: "route-3" },
    });
  });

  it("retires only the failed route when another tab registers its replacement", async () => {
    const current = fixture();
    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();
    current.routes.values.set("route-2", {
      networkId: 1,
      networkLabel: "Lounge",
      nickname: "weblounge",
      vapid: "home-vapid",
      routeId: "route-2",
      deviceId: "device-1",
      endpoint: `${relayOrigin}/v1/r/route-2`,
      p256dh: "replacement-key",
      auth: "replacement-auth",
      privateKey: {} as CryptoKey,
    });

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "invalid_parameters",
      },
    });
    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered", route_id: "route-2" },
    });
    await current.synchronizer.settled();

    expect(current.engine.requests.at(-1)?.request).toEqual({
      type: "unregister_push_route",
      network_id: 1,
      route_id: "route-1",
      endpoint: `${relayOrigin}/v1/r/route-1`,
    });
    expect(current.relay.deleteRoute).toHaveBeenCalledTimes(1);
    expect(current.relay.deleteRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "route-1",
    );
    expect(current.routes.values.has("route-1")).toBe(false);
    expect(current.routes.values.has("route-2")).toBe(true);
    expect(current.relay.createRoute).toHaveBeenCalledOnce();
    expect(current.relay.activateRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "route-2",
    );
    expect(current.routeDiagnostic).toHaveBeenLastCalledWith({
      networkId: 1,
      state: "active",
      routeIdPrefix: "route-2",
    });
  });

  it("keeps the relay route when home unregistration fails", async () => {
    const current = fixture();
    current.engine.emit({
      type: "push_route_required",
      network_id: 1,
      vapid: "home-vapid",
      previous_route_id: null,
    });
    await current.synchronizer.settled();
    current.engine.failUnregister = true;

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "invalid_parameters",
      },
    });
    await current.synchronizer.settled();

    expect(current.relay.deleteRoute).not.toHaveBeenCalled();
    expect(current.routes.values.has("route-1")).toBe(true);
    expect(
      current.engine.requests.filter(
        ({ request }) => request.type === "unregister_push_route",
      ),
    ).toHaveLength(1);
  });

  it("keeps a failed retirement decryptable and retries it on launch", async () => {
    const relayApi = statefulRelay(["old-route"], ["unavailable"]);
    const current = fixture(relayApi);
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("old-route", {
      networkId: 7,
      networkLabel: "Lounge",
      nickname: "weblounge",
      vapid: "old-vapid",
      routeId: "old-route",
      deviceId: "device-1",
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
    expect(current.routes.values.get("old-route")?.retiring).toBe(true);
    expect(current.routes.values.get("new-route-1")?.networkId).toBe(1);

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered", route_id: "new-route-1" },
    });
    await current.synchronizer.settled();
    expect(
      [...relayApi.routes.values()].filter((state) => state === "active"),
    ).toHaveLength(2);
    current.synchronizer.dispose();

    const relaunched = new PushSynchronizer({
      engine: current.engine,
      relay: relayApi,
      relayOrigin,
      target,
      routeContext: () => ({ networkLabel: "Lounge", nickname: "weblounge" }),
      devices: current.devices,
      routes: current.routes,
      acquireSessionToken: current.acquireSessionToken,
      onAuthorizationRequired: current.authorizationRequired,
      generateRouteKeys: async () => ({
        p256dh: "unused",
        auth: "unused",
        privateKey: {} as CryptoKey,
      }),
      exclusive: async (_name, work) => work(),
    });
    await relaunched.settled();

    expect(relayApi.routes).toEqual(new Map([["new-route-1", "active"]]));
    expect(current.routes.values.has("old-route")).toBe(false);
  });

  it("keeps old route keys after a 401 while registering a new device", async () => {
    const relayApi = statefulRelay(["old-route"], ["unauthorized"]);
    const current = fixture(relayApi);
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "old-device",
      secret: "expired-secret",
    };
    current.routes.values.set("old-route", {
      networkId: 1,
      networkLabel: "Lounge",
      nickname: "weblounge",
      vapid: "old-vapid",
      routeId: "old-route",
      deviceId: "old-device",
      endpoint: `${relayOrigin}/v1/r/old-route`,
      p256dh: "old-key",
      auth: "old-auth",
      privateKey: {} as CryptoKey,
    });

    const replacement = {
      type: "push_route_required" as const,
      network_id: 1,
      vapid: "new-vapid",
      previous_route_id: "old-route",
    };
    current.engine.emit(replacement);
    await current.synchronizer.settled();
    expect(current.devices.credentials).toBeUndefined();
    expect(current.routes.values.get("old-route")?.retiring).toBe(true);

    current.engine.emit(replacement);
    await current.synchronizer.settled();

    expect(current.routes.values.has("new-route-1")).toBe(true);
    for (const routeId of relayApi.routes.keys()) {
      expect(current.routes.values.has(routeId)).toBe(true);
    }
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

    expect(current.routes.values.get("route-2")?.routeId).toBe("route-2");
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "register_push",
      route: { route_id: "route-2" },
    });
    expect(current.routeDiagnostic.mock.calls).toContainEqual([
      {
        networkId: 1,
        state: "dead",
        routeIdPrefix: "route-1",
        lastError: "activate: dead_route",
      },
    ]);
    expect(current.routeDiagnostic).toHaveBeenLastCalledWith({
      networkId: 1,
      state: "probing",
      routeIdPrefix: "route-2",
      lastError: "activate: dead_route",
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
    current.routes.values.set("route-1", {
      networkId: 1,
      networkLabel: "Lounge",
      nickname: "weblounge",
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
