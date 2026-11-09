import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";
import type { PushFailure } from "../../engine/generated/PushFailure";
import type { EngineClientMessage } from "../../engine/protocol";
import type { PushDeviceStore } from "./engine-device-store";
import type {
  RelayClient,
  RelayDeadEndpoint,
  RelayDevice,
  RelayFailure,
  RelayResult,
} from "./relay-client";
import { relayRetryDelay } from "./relay-client";
import {
  createRouteKeys,
  hasRouteKeyBytes,
  type PushRouteRecord,
  type PushRouteStore,
  type RouteKeys,
  type StoredPushRoute,
} from "./route-store";
import type { WebPushTarget } from "./subscription";

type RelayApi = Pick<
  RelayClient,
  | "activateRoute"
  | "acknowledgeDeadEndpoints"
  | "createDevice"
  | "deleteDevice"
  | "deleteRoute"
  | "ensureRoute"
  | "takeDeadEndpoints"
  | "updateTarget"
>;

export interface PushSynchronizerOptions {
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
  readonly random?: () => number;
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
  readonly #random: () => number;
  readonly #unsubscribe: () => void;
  readonly #recoveries = new Map<number, ConnectRecovery>();
  readonly #homes = new Map<number, string>();
  readonly #currentRoutes = new Map<number, string>();
  readonly #retryAttempts = new Map<number, number>();
  readonly #cancelRetries = new Map<number, () => void>();
  readonly #pendingActivations = new Set<string>();
  readonly #activeRoutes = new Set<string>();
  readonly #legacyEndpoints = new Set<string>();
  #reconciledDeviceId: string | undefined;
  #reconciledTarget: WebPushTarget | undefined;
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
    this.#random = options.random ?? Math.random;
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
      if (
        this.#currentRoutes.get(message.network_id) !== pushState.route_id ||
        this.#pendingActivations.has(pushState.route_id) ||
        this.#activeRoutes.has(pushState.route_id)
      )
        return;
      this.#retryAttempts.delete(message.network_id);
      this.#pendingActivations.add(pushState.route_id);
      this.#enqueue(async () => {
        try {
          await this.#activate(message.network_id, pushState.route_id);
        } finally {
          this.#pendingActivations.delete(pushState.route_id);
        }
      });
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
      if (!device.ok) {
        if (temporaryRelayFailure(device.error)) {
          for (const networkId of this.#homes.keys()) {
            this.#scheduleRetry(networkId, undefined, device.error);
          }
        }
        return;
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
      if (temporaryRelayFailure(deviceResult.error)) {
        this.#scheduleRetry(networkId, undefined, deviceResult.error);
      }
      return;
    }
    const device = deviceResult.value;
    const reconciledRouteId = this.#currentRoutes.get(networkId);
    const reconciledRoute =
      reconciledRouteId === undefined
        ? undefined
        : await this.#routes.findRoute(reconciledRouteId);
    if (
      !rotate &&
      reconciledRoute?.vapid === home &&
      hasRouteKeyBytes(reconciledRoute) &&
      reconciledRoute.deviceId === device.id &&
      reconciledRoute.needsReregistration !== true
    ) {
      await this.#sendEnsure(networkId, reconciledRoute, []);
      return;
    }
    const legacyRoutes = await this.#legacyRoutes(device);
    const stored = await this.#routes.get(home);
    const current =
      stored !== undefined &&
      hasRouteKeyBytes(stored) &&
      stored.deviceId === device.id &&
      stored.networkLabel.length > 0 &&
      stored.needsReregistration !== true
        ? stored
        : undefined;
    const ensured = await this.#relay.ensureRoute(
      device,
      home,
      rotate ? undefined : current?.routeId,
    );
    if (!ensured.ok) {
      if (ensured.error.kind === "dead_route") {
        await this.#ensureHome(networkId, true);
        return;
      }
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
      if (temporaryRelayFailure(ensured.error))
        this.#scheduleRetry(networkId, undefined, ensured.error);
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
            this.#reconciledTarget ?? this.#target,
          );
    await this.#routes.put(route);
    for (const legacy of legacyRoutes) {
      if (legacy.vapid !== route.vapid) await this.#routes.delete(legacy.vapid);
    }
    this.#currentRoutes.set(networkId, route.routeId);
    const dead = await this.#relay.takeDeadEndpoints(device, home);
    if (!dead.ok && dead.error.kind === "gone") {
      await this.#devices.clear(this.#relayOrigin);
      await this.#ensureHome(networkId, false);
      return;
    }
    if (!dead.ok && dead.error.kind === "unauthorized") {
      this.#onAuthorizationRequired();
    }
    if (!dead.ok && temporaryRelayFailure(dead.error)) {
      this.#scheduleRetry(networkId, undefined, dead.error);
    }
    const unregister = new Set(this.#legacyEndpoints);
    if (dead.ok) {
      for (const endpoint of dead.value) unregister.add(endpoint.endpoint);
    }
    if (await this.#sendEnsure(networkId, route, [...unregister])) {
      this.#legacyEndpoints.clear();
      if (dead.ok)
        await this.#acknowledgeDead(networkId, device, home, dead.value);
    }
  }

  async #sendEnsure(
    networkId: number,
    route: StoredPushRoute,
    unregister: readonly string[],
  ): Promise<boolean> {
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
      return true;
    } catch {
      for (const endpoint of unregister) this.#legacyEndpoints.add(endpoint);
      this.#publish(networkId, "probing", route.routeId, "engine: request");
      this.#scheduleRetry(networkId);
      return false;
    }
  }

  async #activate(networkId: number, routeId: string): Promise<void> {
    const [storedDevice, route] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.findRoute(routeId),
    ]);
    if (storedDevice === undefined || route === undefined) return;
    if (route.active === true) {
      this.#activeRoutes.add(routeId);
      this.#publish(networkId, "active", routeId);
      return;
    }
    const activated = await this.#relay.activateRoute(
      asRelayDevice(storedDevice),
      routeId,
    );
    if (activated.ok) {
      if (!hasRouteKeyBytes(route)) return;
      await this.#routes.put({ ...route, active: true });
      this.#activeRoutes.add(routeId);
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
      this.#scheduleRetry(
        networkId,
        () => this.#activate(networkId, routeId),
        activated.error,
      );
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
    if (!hasRouteKeyBytes(route)) return;
    if (route.active === true) {
      const { active: _active, ...probingRoute } = route;
      await this.#routes.put(probingRoute);
      this.#activeRoutes.delete(route.routeId);
    }
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
      const relayDevice = asRelayDevice(device);
      const dead = await this.#relay.takeDeadEndpoints(relayDevice, home);
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
      if (!dead.ok && temporaryRelayFailure(dead.error)) {
        this.#scheduleRetry(networkId, undefined, dead.error);
      }
      const endpoints = dead.ok
        ? dead.value.map((endpoint) => endpoint.endpoint)
        : [];
      if (await this.#sendEnsure(networkId, route, endpoints)) {
        if (dead.ok)
          await this.#acknowledgeDead(networkId, relayDevice, home, dead.value);
      }
      return;
    }
    if (reason === "web_push_forbidden") {
      await this.#unregisterExact(networkId, route).catch(() => undefined);
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
      const target = this.#target;
      const stored = await this.#devices.load(this.#relayOrigin);
      if (stored !== undefined) {
        const device = asRelayDevice(stored);
        if (await this.#targetIsCurrent(device, target)) {
          this.#onDeviceReady(device);
          return { ok: true, value: device };
        }
        const updated = await this.#relay.updateTarget(device, target);
        if (updated.ok) {
          this.#reconciledDeviceId = device.id;
          this.#reconciledTarget = target;
          await this.#storeCurrentTarget(device, target);
          this.#onDeviceReady(device);
          return { ok: true, value: device };
        }
        if (updated.error.kind === "unauthorized") {
          this.#onAuthorizationRequired();
          return updated;
        }
        if (updated.error.kind !== "gone") return updated;
        await this.#devices.clear(this.#relayOrigin);
        this.#reconciledDeviceId = undefined;
        this.#reconciledTarget = undefined;
      }
      const sessionToken = await this.#acquireSessionToken();
      const created = await this.#relay.createDevice(sessionToken, target);
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
      this.#reconciledDeviceId = created.value.id;
      this.#reconciledTarget = target;
      this.#onDeviceReady(created.value);
      return created;
    });
  }

  async #targetIsCurrent(
    device: RelayDevice,
    target: WebPushTarget,
  ): Promise<boolean> {
    if (
      this.#reconciledDeviceId === device.id &&
      sameTarget(this.#reconciledTarget, target)
    ) {
      return true;
    }
    const routes = await this.#routes.all();
    const current = routes.some(
      (route) =>
        route.deviceId === device.id && sameTarget(route.target, target),
    );
    if (current) {
      this.#reconciledDeviceId = device.id;
      this.#reconciledTarget = target;
    }
    return current;
  }

  async #storeCurrentTarget(
    device: RelayDevice,
    target: WebPushTarget,
  ): Promise<void> {
    const routes = await this.#routes.all();
    await Promise.all(
      routes
        .filter((route) => route.deviceId === device.id)
        .filter(hasRouteKeyBytes)
        .map((route) => this.#routes.put({ ...route, target })),
    );
  }

  async #legacyRoutes(
    device: RelayDevice,
  ): Promise<readonly PushRouteRecord[]> {
    const legacy: PushRouteRecord[] = [];
    for (const route of await this.#routes.all()) {
      if (
        !hasRouteKeyBytes(route) ||
        route.networkLabel.length === 0 ||
        route.deviceId === undefined ||
        route.deviceId !== device.id
      ) {
        this.#legacyEndpoints.add(route.endpoint);
        legacy.push(route);
      }
    }
    return legacy;
  }

  async #acknowledgeDead(
    networkId: number,
    device: RelayDevice,
    home: string,
    endpoints: readonly RelayDeadEndpoint[],
  ): Promise<void> {
    if (endpoints.length === 0) return;
    const acknowledged = await this.#relay.acknowledgeDeadEndpoints(
      device,
      home,
      endpoints.map((endpoint) => endpoint.id),
    );
    if (!acknowledged.ok && acknowledged.error.kind === "unauthorized") {
      this.#onAuthorizationRequired();
    }
    if (!acknowledged.ok && acknowledged.error.kind === "gone") {
      await this.#devices.clear(this.#relayOrigin);
    }
    if (!acknowledged.ok && temporaryRelayFailure(acknowledged.error)) {
      this.#scheduleRetry(networkId, undefined, acknowledged.error);
    }
  }

  async #unregisterExact(
    networkId: number,
    route: PushRouteRecord,
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

  #scheduleRetry(
    networkId: number,
    work?: () => Promise<void>,
    failure?: RelayFailure,
  ): void {
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
      relayRetryDelay(attempt, failure?.retryAfterMs, this.#random),
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
  target: WebPushTarget,
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
    privateKeyPkcs8: keys.privateKeyPkcs8,
    target,
  };
}

function sameTarget(
  current: WebPushTarget | undefined,
  next: WebPushTarget,
): boolean {
  return (
    current !== undefined &&
    current.endpoint === next.endpoint &&
    current.p256dh === next.p256dh &&
    current.auth === next.auth
  );
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
