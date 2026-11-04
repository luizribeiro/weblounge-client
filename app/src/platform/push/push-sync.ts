import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";
import type { PushFailure } from "../../engine/generated/PushFailure";
import type { EngineClientMessage } from "../../engine/protocol";
import type { PushDeviceStore } from "./engine-device-store";
import type {
  RelayClient,
  RelayDevice,
  RelayFailure,
  RelayResult,
} from "./relay-client";
import {
  createRouteKeys,
  type PushRouteStore,
  type RouteKeys,
  type StoredPushRoute,
} from "./route-store";
import type { WebPushTarget } from "./subscription";

type RelayApi = Pick<
  RelayClient,
  | "activateRoute"
  | "createDevice"
  | "deleteDevice"
  | "deleteRoute"
  | "ensureRoute"
  | "takeDeadEndpoints"
  | "updateTarget"
>;

interface PushSynchronizerOptions {
  readonly engine: EngineClient;
  readonly relay: RelayApi;
  readonly relayOrigin: string;
  readonly target: WebPushTarget;
  readonly devices: PushDeviceStore;
  readonly routes: PushRouteStore;
  readonly acquireSessionToken: () => Promise<string>;
  readonly onAuthorizationRequired: () => void;
  readonly routeContext: (networkId: number) => PushRouteContext | undefined;
  readonly onRouteDiagnostic?: (diagnostic: PushRouteDiagnostic) => void;
  readonly onDeviceReady?: (device: RelayDevice) => void;
  readonly generateRouteKeys?: () => Promise<RouteKeys>;
  readonly exclusive?: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  readonly retry?: (work: () => void, delayMs: number) => () => void;
}

export type PushRelayRouteState = "none" | "probing" | "active" | "dead";

export interface PushRouteDiagnostic {
  readonly networkId: number;
  readonly state: PushRelayRouteState;
  readonly routeIdPrefix?: string;
  readonly lastError?: string;
}

interface PushRouteContext {
  readonly networkLabel: string;
  readonly nickname: string;
}

interface ConnectRecovery {
  invalidRotations: number;
  limitRetries: number;
}

export class PushSynchronizer {
  readonly #engine: EngineClient;
  readonly #relay: RelayApi;
  readonly #relayOrigin: string;
  readonly #devices: PushDeviceStore;
  readonly #routes: PushRouteStore;
  readonly #acquireSessionToken: () => Promise<string>;
  readonly #onAuthorizationRequired: () => void;
  readonly #routeContext: (networkId: number) => PushRouteContext | undefined;
  readonly #onRouteDiagnostic: (diagnostic: PushRouteDiagnostic) => void;
  readonly #onDeviceReady: (device: RelayDevice) => void;
  readonly #generateRouteKeys: () => Promise<RouteKeys>;
  readonly #exclusive: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  readonly #retry: (work: () => void, delayMs: number) => () => void;
  readonly #unsubscribe: () => void;
  readonly #recoveries = new Map<number, ConnectRecovery>();
  readonly #homes = new Map<number, string>();
  readonly #currentRoutes = new Map<number, string>();
  readonly #retryAttempts = new Map<number, number>();
  readonly #cancelRetries = new Map<number, () => void>();
  readonly #legacyEndpoints = new Set<string>();
  #target: WebPushTarget;
  #pending: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: PushSynchronizerOptions) {
    this.#engine = options.engine;
    this.#relay = options.relay;
    this.#relayOrigin = options.relayOrigin;
    this.#target = options.target;
    this.#devices = options.devices;
    this.#routes = options.routes;
    this.#acquireSessionToken = options.acquireSessionToken;
    this.#onAuthorizationRequired = options.onAuthorizationRequired;
    this.#routeContext = options.routeContext;
    this.#onRouteDiagnostic = options.onRouteDiagnostic ?? (() => {});
    this.#onDeviceReady = options.onDeviceReady ?? (() => {});
    this.#generateRouteKeys = options.generateRouteKeys ?? createRouteKeys;
    this.#exclusive = options.exclusive ?? withExclusiveLock;
    this.#retry = options.retry ?? browserRetry;
    this.#unsubscribe = this.#engine.subscribe((message) =>
      this.handle(message),
    );
  }

  handle(message: EngineClientMessage): void {
    if (message.type === "push_route_required") {
      this.#homes.set(message.network_id, message.vapid);
      this.#recoveries.set(message.network_id, {
        invalidRotations: 0,
        limitRetries: 0,
      });
      this.#cancelRetry(message.network_id);
      this.#enqueue(() =>
        this.#withHomeLock(message.vapid, () =>
          this.#ensureHome(message.network_id, false),
        ),
      );
      return;
    }
    if (message.type !== "push_state_changed") return;
    const pushState = message.state;
    if (pushState.status === "registered") {
      if (this.#currentRoutes.get(message.network_id) !== pushState.route_id)
        return;
      this.#retryAttempts.delete(message.network_id);
      this.#enqueue(() =>
        this.#activate(message.network_id, pushState.route_id),
      );
      return;
    }
    if (pushState.status === "failed") {
      this.#enqueue(() =>
        this.#recoverRegistration(
          message.network_id,
          pushState.route_id,
          pushState.reason,
        ),
      );
      return;
    }
    if (pushState.status === "unsupported") {
      this.#enqueue(() => this.unregisterNetwork(message.network_id));
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
    for (const cancel of this.#cancelRetries.values()) cancel();
    this.#cancelRetries.clear();
  }

  async settled(): Promise<void> {
    let pending = this.#pending;
    while (true) {
      await pending;
      if (pending === this.#pending) return;
      pending = this.#pending;
    }
  }

  async refreshTarget(target: WebPushTarget): Promise<void> {
    this.#target = target;
    this.#enqueue(async () => {
      const device = await this.#ensureDevice();
      if (!device.ok) return;
      for (const [networkId, home] of this.#homes) {
        await this.#withHomeLock(home, () =>
          this.#ensureHome(networkId, false),
        );
      }
    });
    await this.settled();
  }

  async unregisterNetwork(networkId: number): Promise<void> {
    const home = this.#homes.get(networkId);
    const route = home === undefined ? undefined : await this.#routes.get(home);
    const device = await this.#devices.load(this.#relayOrigin);
    if (route !== undefined) {
      await this.#unregisterExact(networkId, route).catch(() => undefined);
      if (device !== undefined) {
        await this.#relay.deleteRoute(asRelayDevice(device), route.routeId);
      }
      await this.#routes.delete(route.vapid);
    }
    this.#homes.delete(networkId);
    this.#currentRoutes.delete(networkId);
    this.#publish(networkId, "none");
  }

  async signOut(): Promise<void> {
    const [storedDevice, routes] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.all(),
    ]);
    for (const route of routes) {
      await this.#unregisterExact(route.networkId, route).catch(
        () => undefined,
      );
    }
    if (storedDevice !== undefined) {
      const deleted = await this.#relay.deleteDevice(
        asRelayDevice(storedDevice),
      );
      if (!deleted.ok && deleted.error.kind === "unauthorized") {
        this.#onAuthorizationRequired();
      }
    }
    await Promise.all(routes.map((route) => this.#routes.delete(route.vapid)));
    await this.#devices.clear(this.#relayOrigin);
    for (const networkId of this.#homes.keys()) {
      this.#publish(networkId, "none");
    }
    this.#homes.clear();
    this.#currentRoutes.clear();
  }

  #enqueue(work: () => Promise<void>): void {
    this.#pending = this.#pending.then(work).catch(() => undefined);
  }

  #withHomeLock<T>(home: string, work: () => Promise<T>): Promise<T> {
    return this.#exclusive(`weblounge-push-home-${home}`, work);
  }

  async #ensureHome(networkId: number, rotate: boolean): Promise<void> {
    const home = this.#homes.get(networkId);
    const context = this.#routeContext(networkId);
    if (home === undefined || context === undefined || this.#disposed) return;
    const deviceResult = await this.#ensureDevice();
    if (!deviceResult.ok) {
      this.#publish(
        networkId,
        "none",
        undefined,
        relayError("device", deviceResult.error),
      );
      return;
    }
    const device = deviceResult.value;
    await this.#cleanLegacyRoutes(device);
    const stored = await this.#routes.get(home);
    const current =
      stored !== undefined &&
      stored.deviceId === device.id &&
      stored.networkLabel.length > 0
        ? stored
        : undefined;
    const ensured = await this.#relay.ensureRoute(
      device,
      home,
      rotate ? undefined : current?.routeId,
    );
    if (!ensured.ok) {
      if (ensured.error.kind === "gone") {
        await this.#devices.clear(this.#relayOrigin);
        await this.#ensureHome(networkId, rotate);
        return;
      }
      if (ensured.error.kind === "unauthorized") {
        this.#onAuthorizationRequired();
      }
      this.#publish(
        networkId,
        current === undefined ? "none" : "probing",
        current?.routeId,
        relayError("ensure", ensured.error),
      );
      if (temporaryRelayFailure(ensured.error)) this.#scheduleRetry(networkId);
      return;
    }
    const route =
      current?.routeId === ensured.value.id
        ? { ...current, ...context, networkId }
        : storedRoute(
            networkId,
            context,
            home,
            await this.#generateRouteKeys(),
            ensured.value,
            device.id,
          );
    await this.#routes.put(route);
    this.#currentRoutes.set(networkId, route.routeId);
    const dead = await this.#relay.takeDeadEndpoints(device);
    if (!dead.ok && dead.error.kind === "gone") {
      await this.#devices.clear(this.#relayOrigin);
      await this.#ensureHome(networkId, false);
      return;
    }
    if (!dead.ok && dead.error.kind === "unauthorized") {
      this.#onAuthorizationRequired();
    }
    const unregister = new Set(this.#legacyEndpoints);
    if (dead.ok) for (const endpoint of dead.value) unregister.add(endpoint);
    await this.#sendEnsure(networkId, route, [...unregister]);
    this.#legacyEndpoints.clear();
  }

  async #sendEnsure(
    networkId: number,
    route: StoredPushRoute,
    unregister: readonly string[],
  ): Promise<void> {
    this.#publish(networkId, "probing", route.routeId);
    try {
      await this.#engine.send({
        id: crypto.randomUUID(),
        request: {
          type: "ensure_push",
          network_id: networkId,
          route: {
            route_id: route.routeId,
            endpoint: route.endpoint,
            p256dh: route.p256dh,
            auth: route.auth,
          },
          unregister: [...unregister],
        },
      });
    } catch {
      for (const endpoint of unregister) this.#legacyEndpoints.add(endpoint);
      this.#publish(networkId, "probing", route.routeId, "engine: request");
      this.#scheduleRetry(networkId);
    }
  }

  async #activate(networkId: number, routeId: string): Promise<void> {
    const [storedDevice, route] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.findRoute(routeId),
    ]);
    if (storedDevice === undefined || route === undefined) return;
    const activated = await this.#relay.activateRoute(
      asRelayDevice(storedDevice),
      routeId,
    );
    if (activated.ok) {
      this.#publish(networkId, "active", routeId);
      this.#retryAttempts.delete(networkId);
      return;
    }
    this.#publish(
      networkId,
      activated.error.kind === "dead_route" ? "dead" : "probing",
      routeId,
      relayError("activate", activated.error),
    );
    if (activated.error.kind === "dead_route") {
      await this.#withHomeLock(route.vapid, () =>
        this.#ensureHome(networkId, true),
      );
    } else if (activated.error.kind === "gone") {
      await this.#devices.clear(this.#relayOrigin);
      await this.#withHomeLock(route.vapid, () =>
        this.#ensureHome(networkId, false),
      );
    } else if (activated.error.kind === "unauthorized") {
      this.#onAuthorizationRequired();
    } else if (temporaryRelayFailure(activated.error)) {
      this.#scheduleRetry(networkId, () => this.#activate(networkId, routeId));
    }
  }

  async #recoverRegistration(
    networkId: number,
    failedRouteId: string,
    reason: PushFailure,
  ): Promise<void> {
    if (this.#currentRoutes.get(networkId) !== failedRouteId) return;
    const home = this.#homes.get(networkId);
    const route = await this.#routes.findRoute(failedRouteId);
    if (home === undefined || route === undefined) return;
    const recovery = this.#recoveries.get(networkId) ?? {
      invalidRotations: 0,
      limitRetries: 0,
    };
    if (reason === "invalid_parameters" && recovery.invalidRotations < 1) {
      recovery.invalidRotations += 1;
      this.#recoveries.set(networkId, recovery);
      await this.#withHomeLock(home, () => this.#ensureHome(networkId, true));
      return;
    }
    if (reason === "registration_limit" && recovery.limitRetries < 1) {
      recovery.limitRetries += 1;
      this.#recoveries.set(networkId, recovery);
      const device = await this.#devices.load(this.#relayOrigin);
      if (device === undefined) return;
      const dead = await this.#relay.takeDeadEndpoints(asRelayDevice(device));
      if (!dead.ok && dead.error.kind === "gone") {
        await this.#devices.clear(this.#relayOrigin);
        await this.#withHomeLock(home, () =>
          this.#ensureHome(networkId, false),
        );
        return;
      }
      if (!dead.ok && dead.error.kind === "unauthorized") {
        this.#onAuthorizationRequired();
      }
      await this.#sendEnsure(networkId, route, dead.ok ? dead.value : []);
      return;
    }
    if (reason === "web_push_forbidden") {
      const device = await this.#devices.load(this.#relayOrigin);
      if (device !== undefined) {
        await this.#relay.deleteRoute(asRelayDevice(device), route.routeId);
      }
      await this.#routes.delete(route.vapid);
      this.#publish(networkId, "dead", route.routeId, `engine: ${reason}`);
      return;
    }
    this.#publish(networkId, "probing", route.routeId, `engine: ${reason}`);
    this.#scheduleRetry(networkId);
  }

  async #ensureDevice(): Promise<RelayResult<RelayDevice>> {
    return this.#exclusive("weblounge-push-device", async () => {
      const stored = await this.#devices.load(this.#relayOrigin);
      if (stored !== undefined) {
        const device = asRelayDevice(stored);
        const updated = await this.#relay.updateTarget(device, this.#target);
        if (updated.ok) {
          this.#onDeviceReady(device);
          return { ok: true, value: device };
        }
        if (updated.error.kind === "unauthorized") {
          this.#onAuthorizationRequired();
          return updated;
        }
        if (updated.error.kind !== "gone") return updated;
        await this.#devices.clear(this.#relayOrigin);
      }
      const sessionToken = await this.#acquireSessionToken();
      const created = await this.#relay.createDevice(
        sessionToken,
        this.#target,
      );
      if (!created.ok) {
        if (created.error.kind === "unauthorized") {
          this.#onAuthorizationRequired();
        }
        return created;
      }
      await this.#devices.store({
        relay: this.#relayOrigin,
        device_id: created.value.id,
        secret: created.value.secret,
      });
      this.#onDeviceReady(created.value);
      return created;
    });
  }

  async #cleanLegacyRoutes(device: RelayDevice): Promise<void> {
    for (const route of await this.#routes.all()) {
      if (
        route.networkLabel.length === 0 ||
        route.deviceId === undefined ||
        route.deviceId !== device.id
      ) {
        this.#legacyEndpoints.add(route.endpoint);
        await this.#routes.delete(route.vapid);
      }
    }
  }

  async #unregisterExact(
    networkId: number,
    route: StoredPushRoute,
  ): Promise<void> {
    await this.#engine.send({
      id: crypto.randomUUID(),
      request: {
        type: "unregister_push_route",
        network_id: networkId,
        route_id: route.routeId,
        endpoint: route.endpoint,
      },
    });
  }

  #scheduleRetry(networkId: number, work?: () => Promise<void>): void {
    this.#cancelRetry(networkId);
    const attempt = this.#retryAttempts.get(networkId) ?? 0;
    this.#retryAttempts.set(networkId, attempt + 1);
    const cancel = this.#retry(
      () => {
        this.#cancelRetries.delete(networkId);
        this.#enqueue(
          work ??
            (() => {
              const home = this.#homes.get(networkId);
              return home === undefined
                ? Promise.resolve()
                : this.#withHomeLock(home, () =>
                    this.#ensureHome(networkId, false),
                  );
            }),
        );
      },
      Math.min(5 * 60_000, 1_000 * 2 ** attempt),
    );
    this.#cancelRetries.set(networkId, cancel);
  }

  #cancelRetry(networkId: number): void {
    this.#cancelRetries.get(networkId)?.();
    this.#cancelRetries.delete(networkId);
  }

  #publish(
    networkId: number,
    state: PushRelayRouteState,
    routeId?: string,
    lastError?: string,
  ): void {
    this.#onRouteDiagnostic({
      networkId,
      state,
      ...(routeId === undefined ? {} : { routeIdPrefix: routeId.slice(0, 8) }),
      ...(lastError === undefined ? {} : { lastError }),
    });
  }
}

function storedRoute(
  networkId: number,
  context: PushRouteContext,
  vapid: string,
  keys: RouteKeys,
  route: { readonly id: string; readonly endpoint: string },
  deviceId: string,
): StoredPushRoute {
  return {
    networkId,
    ...context,
    vapid,
    routeId: route.id,
    deviceId,
    endpoint: route.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    privateKey: keys.privateKey,
  };
}

function temporaryRelayFailure(failure: RelayFailure): boolean {
  return failure.kind === "unavailable" || failure.kind === "capacity";
}

function relayError(operation: string, failure: RelayFailure): string {
  return `${operation}: ${failure.kind}`;
}

function asRelayDevice(credentials: PushDeviceCredentials): RelayDevice {
  return { id: credentials.device_id, secret: credentials.secret };
}

function browserRetry(work: () => void, delayMs: number): () => void {
  const timer = window.setTimeout(work, delayMs);
  return () => window.clearTimeout(timer);
}

const localLocks = new Map<string, Promise<void>>();

async function withExclusiveLock<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (navigator.locks !== undefined) {
    return navigator.locks.request(name, { mode: "exclusive" }, work);
  }
  const previous = localLocks.get(name) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  localLocks.set(name, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (localLocks.get(name) === queued) localLocks.delete(name);
  }
}
