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
const rotatedTarget = {
  endpoint: "https://fcm.googleapis.com/fcm/send/rotated",
  p256dh: "rotated-browser-key",
  auth: "rotated-browser-auth",
};

class FakeEngine implements EngineClient {
  readonly requests: EngineRequestEnvelope[] = [];
  failExactUnregister = false;
  failEnsure = false;
  readonly #listeners = new Set<(message: EngineClientMessage) => void>();

  start(_hello: Hello): Promise<void> {
    return Promise.resolve();
  }

  send(request: EngineRequestEnvelope) {
    this.requests.push(request);
    if (
      this.failExactUnregister &&
      request.request.type === "unregister_push_route"
    ) {
      return Promise.reject(new Error("offline"));
    }
    if (this.failEnsure && request.request.type === "ensure_push") {
      return Promise.reject(new Error("offline"));
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

  get(homeVapid: string): Promise<StoredPushRoute | undefined> {
    return Promise.resolve(this.values.get(homeVapid));
  }

  findRoute(routeId: string): Promise<StoredPushRoute | undefined> {
    return Promise.resolve(
      [...this.values.values()].find((route) => route.routeId === routeId),
    );
  }

  put(route: StoredPushRoute): Promise<void> {
    this.values.set(route.vapid, route);
    return Promise.resolve();
  }

  delete(homeVapid: string): Promise<void> {
    this.values.delete(homeVapid);
    return Promise.resolve();
  }

  all(): Promise<readonly StoredPushRoute[]> {
    return Promise.resolve([...this.values.values()]);
  }
}

function fakeRelay() {
  let routeSequence = 0;
  const deadEndpoints: Array<Array<{ id: string; endpoint: string }>> = [[]];
  const relay = {
    createDevice: vi.fn<RelayClient["createDevice"]>(async () => ({
      ok: true,
      value: { id: "device-1", secret: "device-secret" },
    })),
    updateTarget: vi.fn<RelayClient["updateTarget"]>(async () => ({
      ok: true,
      value: null,
    })),
    deleteDevice: vi.fn<RelayClient["deleteDevice"]>(async () => ({
      ok: true,
      value: null,
    })),
    ensureRoute: vi.fn<RelayClient["ensureRoute"]>(
      async (_device, _home, myRouteId) => {
        routeSequence += 1;
        const id = myRouteId ?? `route-${routeSequence}`;
        return {
          ok: true,
          value: { id, endpoint: `${relayOrigin}/v1/r/${id}` },
        };
      },
    ),
    takeDeadEndpoints: vi.fn<RelayClient["takeDeadEndpoints"]>(async () => ({
      ok: true,
      value: deadEndpoints.shift() ?? [],
    })),
    acknowledgeDeadEndpoints: vi.fn<RelayClient["acknowledgeDeadEndpoints"]>(
      async () => ({ ok: true, value: null }),
    ),
    activateRoute: vi.fn<RelayClient["activateRoute"]>(async () => ({
      ok: true,
      value: null,
    })),
    deleteRoute: vi.fn<RelayClient["deleteRoute"]>(async () => ({
      ok: true,
      value: null,
    })),
  };
  return { deadEndpoints, relay };
}

function fixture() {
  const engine = new FakeEngine();
  const devices = new MemoryDevices();
  const routes = new MemoryRoutes();
  const { deadEndpoints, relay } = fakeRelay();
  const diagnostics = vi.fn();
  const authorizationRequired = vi.fn();
  const retries: Array<() => void> = [];
  const retryDelays: number[] = [];
  const synchronizer = new PushSynchronizer({
    engine,
    relay,
    relayOrigin,
    target,
    devices,
    routes,
    acquireSessionToken: async () => "member-session",
    onAuthorizationRequired: authorizationRequired,
    routeContext: () => ({ networkLabel: "Lounge", nickname: "weblounge" }),
    onRouteDiagnostic: diagnostics,
    generateRouteKeys: async () => ({
      p256dh: "route-public-key",
      auth: "route-auth",
      privateKey: {} as CryptoKey,
    }),
    exclusive: async (_name, work) => work(),
    retry: (work, delay) => {
      retries.push(work);
      retryDelays.push(delay);
      return () => {};
    },
    random: () => 0,
  });
  return {
    authorizationRequired,
    deadEndpoints,
    devices,
    diagnostics,
    engine,
    relay,
    retries,
    retryDelays,
    routes,
    synchronizer,
  };
}

function requireRoute(engine: FakeEngine, vapid = "home-vapid"): void {
  engine.emit({
    type: "push_route_required",
    network_id: 1,
    vapid,
    previous_route_id: null,
  });
}

function route(overrides: Partial<StoredPushRoute> = {}): StoredPushRoute {
  return {
    networkId: 1,
    networkLabel: "Lounge",
    nickname: "weblounge",
    vapid: "home-vapid",
    routeId: "route-1",
    deviceId: "device-1",
    endpoint: `${relayOrigin}/v1/r/route-1`,
    p256dh: "route-public-key",
    auth: "route-auth",
    privateKey: {} as CryptoKey,
    ...overrides,
  };
}

describe("push state synchronization", () => {
  it("ensures one route with dead endpoints and activates only after registration", async () => {
    const current = fixture();
    current.deadEndpoints[0] = [
      { id: "dead-route", endpoint: `${relayOrigin}/v1/r/dead-route` },
    ];

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.createDevice).toHaveBeenCalledOnce();
    expect(current.relay.ensureRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      undefined,
    );
    expect(current.engine.requests).toHaveLength(1);
    expect(current.engine.requests[0]?.request).toMatchObject({
      type: "ensure_push",
      unregister: [`${relayOrigin}/v1/r/dead-route`],
      route: { route_id: "route-1" },
    });
    expect(current.relay.activateRoute).not.toHaveBeenCalled();
    expect(current.relay.takeDeadEndpoints).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
    );
    expect(current.relay.acknowledgeDeadEndpoints).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      ["dead-route"],
    );

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
  });

  it("reuses one relay reconciliation for repeated connection requirements", async () => {
    const current = fixture();

    for (let index = 0; index < 5; index += 1) {
      requireRoute(current.engine);
    }
    await current.synchronizer.settled();

    expect(current.relay.createDevice).toHaveBeenCalledOnce();
    expect(current.relay.ensureRoute).toHaveBeenCalledOnce();
    expect(current.relay.takeDeadEndpoints).toHaveBeenCalledOnce();
    expect(current.engine.requests).toHaveLength(5);
    expect(current.engine.requests.map(({ request }) => request)).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({
          type: "ensure_push",
          route: expect.objectContaining({ route_id: "route-1" }),
        }),
      ),
    );
  });

  it("deduplicates shared registration outcomes and remembers activation", async () => {
    const current = fixture();
    requireRoute(current.engine);
    await current.synchronizer.settled();
    const registered = {
      type: "push_state_changed" as const,
      network_id: 1,
      state: { status: "registered" as const, route_id: "route-1" },
    };

    current.engine.emit(registered);
    current.engine.emit(registered);
    current.engine.emit(registered);
    await current.synchronizer.settled();

    expect(current.relay.activateRoute).toHaveBeenCalledOnce();
    expect(current.routes.values.get("home-vapid")?.active).toBe(true);
  });

  it("updates the stored target and reuses the home-keyed route", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route());

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.updateTarget).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      target,
    );
    expect(current.relay.ensureRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      "route-1",
    );
    expect(current.routes.values.size).toBe(1);
    expect(current.routes.values.get("home-vapid")?.target).toEqual(target);
  });

  it("stamps only the target confirmed by the relay", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route());
    let confirmFirstUpdate = () => {};
    current.relay.updateTarget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmFirstUpdate = () => resolve({ ok: true, value: null });
        }),
    );

    requireRoute(current.engine);
    await vi.waitFor(() =>
      expect(current.relay.updateTarget).toHaveBeenCalledOnce(),
    );
    const refreshed = current.synchronizer.refreshTarget(rotatedTarget);
    confirmFirstUpdate();
    await refreshed;

    expect(
      current.relay.updateTarget.mock.calls.map(([, value]) => value),
    ).toEqual([target, rotatedTarget]);
    expect(current.routes.values.get("home-vapid")?.target).toEqual(
      rotatedTarget,
    );
  });

  it("skips an unchanged target across home and foreground reconciliation", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route({ target }));

    requireRoute(current.engine);
    await current.synchronizer.settled();
    await current.synchronizer.refreshTarget(target);

    expect(current.relay.updateTarget).not.toHaveBeenCalled();
    expect(current.relay.ensureRoute).toHaveBeenCalledOnce();
  });

  it("does not reactivate a route already active at the relay", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route({ target, active: true }));
    requireRoute(current.engine);
    await current.synchronizer.settled();

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "registered", route_id: "route-1" },
    });
    await current.synchronizer.settled();

    expect(current.relay.activateRoute).not.toHaveBeenCalled();
  });

  it("rotates a cached active route when the relay reports it dead", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route({ target, active: true }));
    current.relay.ensureRoute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "dead_route" },
    });
    current.relay.ensureRoute.mockResolvedValueOnce({
      ok: true,
      value: {
        id: "route-2",
        endpoint: `${relayOrigin}/v1/r/route-2`,
      },
    });

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.ensureRoute).toHaveBeenNthCalledWith(
      2,
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      undefined,
    );
    expect(current.routes.values.get("home-vapid")?.active).toBeUndefined();
  });

  it("recreates a cached device when route validation reports it gone", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route({ target, active: true }));
    current.relay.ensureRoute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "gone" },
    });
    current.relay.createDevice.mockResolvedValueOnce({
      ok: true,
      value: { id: "device-2", secret: "device-2-secret" },
    });

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.createDevice).toHaveBeenCalledOnce();
    expect(current.routes.values.get("home-vapid")?.active).toBeUndefined();
  });

  it("rotates a route whose worker keys failed", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set(
      "home-vapid",
      route({ routeId: "failed-route", needsReregistration: true }),
    );

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.ensureRoute).toHaveBeenCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      undefined,
    );
    const stored = current.routes.values.get("home-vapid");
    expect(stored?.routeId).toBe("route-1");
    expect(stored?.needsReregistration).toBeUndefined();
  });

  it("rotates invalid parameters once per connection", async () => {
    const current = fixture();
    requireRoute(current.engine);
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
    expect(current.relay.ensureRoute).toHaveBeenLastCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      undefined,
    );
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "ensure_push",
      route: { route_id: "route-2" },
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
    expect(current.relay.ensureRoute).toHaveBeenCalledTimes(2);
    expect(current.retries).toHaveLength(1);
  });

  it("purges newly dead endpoints and retries a registration limit once", async () => {
    const current = fixture();
    current.deadEndpoints.push([
      { id: "expired", endpoint: `${relayOrigin}/v1/r/expired` },
    ]);
    requireRoute(current.engine);
    await current.synchronizer.settled();

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "registration_limit",
      },
    });
    await current.synchronizer.settled();
    expect(current.engine.requests.at(-1)?.request).toMatchObject({
      type: "ensure_push",
      unregister: [`${relayOrigin}/v1/r/expired`],
      route: { route_id: "route-1" },
    });
    expect(current.relay.acknowledgeDeadEndpoints).toHaveBeenLastCalledWith(
      { id: "device-1", secret: "device-secret" },
      "home-vapid",
      ["expired"],
    );
  });

  it("does not acknowledge dead endpoints before engine cleanup succeeds", async () => {
    const current = fixture();
    current.engine.failEnsure = true;
    current.deadEndpoints[0] = [
      { id: "dead-route", endpoint: `${relayOrigin}/v1/r/dead-route` },
    ];

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.acknowledgeDeadEndpoints).not.toHaveBeenCalled();
    expect(current.retries).toHaveLength(1);
  });

  it("keeps temporary failures and backs off", async () => {
    const current = fixture();
    requireRoute(current.engine);
    await current.synchronizer.settled();

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "connection",
      },
    });
    await current.synchronizer.settled();
    expect(current.routes.values.get("home-vapid")?.routeId).toBe("route-1");
    expect(current.relay.deleteRoute).not.toHaveBeenCalled();
    expect(current.retries).toHaveLength(1);
  });

  it("invalidates cached activation when registration needs recovery", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route({ target, active: true }));
    requireRoute(current.engine);
    await current.synchronizer.settled();

    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "connection",
      },
    });
    await current.synchronizer.settled();

    expect(current.routes.values.get("home-vapid")?.active).toBeUndefined();
  });

  it("backs an opaque target failure off before device reconciliation", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route());
    current.relay.updateTarget.mockResolvedValueOnce({
      ok: false,
      error: { kind: "capacity", retryAfterMs: 12_000 },
    });

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.retries).toHaveLength(1);
    expect(current.retryDelays).toEqual([12_000]);
    expect(current.relay.ensureRoute).not.toHaveBeenCalled();
  });

  it("keeps an active route when the engine briefly reports unsupported", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route());

    requireRoute(current.engine);
    await current.synchronizer.settled();
    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: { status: "unsupported", reason: "no_account" },
    });
    await current.synchronizer.settled();

    expect(current.relay.deleteRoute).not.toHaveBeenCalled();
    expect(current.routes.values.get("home-vapid")?.routeId).toBe("route-1");
    expect(current.engine.requests).not.toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ type: "unregister_push_route" }),
      }),
    );
  });

  it("turns forbidden registration off visibly", async () => {
    const current = fixture();
    requireRoute(current.engine);
    await current.synchronizer.settled();
    current.engine.emit({
      type: "push_state_changed",
      network_id: 1,
      state: {
        status: "failed",
        route_id: "route-1",
        reason: "web_push_forbidden",
      },
    });
    await current.synchronizer.settled();

    expect(current.engine.requests.at(-1)?.request).toEqual({
      type: "unregister_push_route",
      network_id: 1,
      route_id: "route-1",
      endpoint: `${relayOrigin}/v1/r/route-1`,
    });
    expect(current.relay.deleteRoute).toHaveBeenCalledOnce();
    expect(current.routes.values.size).toBe(0);
    expect(current.diagnostics).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "dead", lastError: expect.any(String) }),
    );
  });

  it("cleans legacy records into the connect-time unregister list", async () => {
    const current = fixture();
    const { deviceId: _deviceId, ...legacy } = route({
      vapid: "legacy-home",
      routeId: "legacy-route",
      endpoint: `${relayOrigin}/v1/r/legacy-route`,
      networkLabel: "",
    });
    current.routes.values.set("legacy-home", legacy);
    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.engine.requests[0]?.request).toMatchObject({
      type: "ensure_push",
      unregister: [`${relayOrigin}/v1/r/legacy-route`],
    });
    expect(current.routes.values.has("legacy-home")).toBe(false);
  });

  it("keeps legacy route keys when relay ensure fails", async () => {
    const current = fixture();
    const { deviceId: _deviceId, ...legacy } = route({
      vapid: "legacy-home",
      routeId: "legacy-route",
      networkLabel: "",
    });
    current.routes.values.set("legacy-home", legacy);
    current.relay.ensureRoute.mockResolvedValueOnce({
      ok: false,
      error: { kind: "unavailable" },
    });

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.routes.values.get("legacy-home")).toEqual(legacy);
    expect(current.engine.requests).toEqual([]);
  });

  it("deletes the relay device on sign-out even when IRC cleanup fails", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "device-1",
      secret: "device-secret",
    };
    current.routes.values.set("home-vapid", route());
    current.engine.failExactUnregister = true;

    await current.synchronizer.signOut();

    expect(current.relay.deleteDevice).toHaveBeenCalledWith({
      id: "device-1",
      secret: "device-secret",
    });
    expect(current.devices.credentials).toBeUndefined();
    expect(current.routes.values.size).toBe(0);
  });

  it("re-upserts when a stored device is gone", async () => {
    const current = fixture();
    current.devices.credentials = {
      relay: relayOrigin,
      device_id: "dead-device",
      secret: "dead-secret",
    };
    current.relay.updateTarget.mockResolvedValueOnce({
      ok: false,
      error: { kind: "gone" },
    });

    requireRoute(current.engine);
    await current.synchronizer.settled();

    expect(current.relay.createDevice).toHaveBeenCalledOnce();
    expect(current.devices.credentials?.device_id).toBe("device-1");
  });
});
