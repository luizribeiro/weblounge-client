import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";
import type { EngineClientMessage } from "../../engine/protocol";
import type { PushDeviceStore } from "./engine-device-store";
import type {
  RelayClient,
  RelayDevice,
  RelayFailure,
  RelayResult,
  RelayRoute,
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
  "createDevice" | "createRoute" | "activateRoute" | "deleteRoute"
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

export class PushSynchronizer {
  readonly #engine: EngineClient;
  readonly #relay: RelayApi;
  readonly #relayOrigin: string;
  readonly #target: WebPushTarget;
  readonly #devices: PushDeviceStore;
  readonly #routes: PushRouteStore;
  readonly #acquireSessionToken: () => Promise<string>;
  readonly #onAuthorizationRequired: () => void;
  readonly #routeContext: (networkId: number) => PushRouteContext | undefined;
  readonly #onRouteDiagnostic: (diagnostic: PushRouteDiagnostic) => void;
  readonly #onDeviceReady: (device: RelayDevice) => void;
  readonly #generateRouteKeys: () => Promise<RouteKeys>;
  readonly #exclusive: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  readonly #unsubscribe: () => void;
  readonly #registrationRecoveries = new Map<number, number>();
  readonly #unregistering = new Set<number>();
  readonly #currentRoutes = new Map<number, string>();
  readonly #pushStateVersions = new Map<number, number>();
  #pending: Promise<void> = Promise.resolve();

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
    this.#unsubscribe = this.#engine.subscribe((message) =>
      this.handle(message),
    );
  }

  handle(message: EngineClientMessage): void {
    this.#onEngineMessage(message);
  }

  dispose(): void {
    this.#unsubscribe();
  }

  async settled(): Promise<void> {
    let pending = this.#pending;
    while (true) {
      await pending;
      if (pending === this.#pending) return;
      pending = this.#pending;
    }
  }

  async unregisterNetwork(networkId: number): Promise<void> {
    await this.#dropRoute(networkId, true);
  }

  async signOut(): Promise<void> {
    const device = await this.#devices.load(this.#relayOrigin);
    const routes = await this.#routes.all();
    if (device !== undefined) {
      for (const route of routes) {
        if (!(await this.#unregisterRouteEngine(route.networkId, route))) {
          continue;
        }
        await this.#retire(route, asRelayDevice(device));
      }
    } else {
      await Promise.all(
        routes.map((route) => this.#routes.put({ ...route, retiring: true })),
      );
    }
    for (const route of routes) this.#publish(route.networkId, "none");
    await this.#devices.clear(this.#relayOrigin);
  }

  #onEngineMessage(message: EngineClientMessage): void {
    if (message.type === "push_route_required") {
      this.#registrationRecoveries.delete(message.network_id);
      if (message.previous_route_id !== null) {
        this.#currentRoutes.set(message.network_id, message.previous_route_id);
      }
      this.#enqueue(() =>
        this.#withNetworkLock(message.network_id, () =>
          this.#routeRequired(
            message.network_id,
            message.vapid,
            message.previous_route_id ?? undefined,
          ),
        ),
      );
      return;
    }
    if (message.type !== "push_state_changed") return;
    const stateVersion =
      (this.#pushStateVersions.get(message.network_id) ?? 0) + 1;
    this.#pushStateVersions.set(message.network_id, stateVersion);
    if (message.state.status === "registered") {
      this.#registrationRecoveries.delete(message.network_id);
      const routeId = message.state.route_id;
      this.#currentRoutes.set(message.network_id, routeId);
      this.#enqueue(() =>
        this.#withNetworkLock(message.network_id, () =>
          this.#activate(message.network_id, routeId),
        ),
      );
    } else if (message.state.status === "failed") {
      if (this.#unregistering.has(message.network_id)) return;
      const reason = message.state.reason;
      const routeId = message.state.route_id;
      this.#enqueue(() =>
        this.#withNetworkLock(message.network_id, () =>
          this.#recoverRegistration(
            message.network_id,
            routeId,
            reason,
            stateVersion,
          ),
        ),
      );
    } else if (message.state.status === "unsupported") {
      this.#enqueue(() =>
        this.#withNetworkLock(message.network_id, () =>
          this.#dropRoute(message.network_id, false),
        ),
      );
    }
  }

  #enqueue(work: () => Promise<void>): void {
    this.#pending = this.#pending.then(work).catch(() => undefined);
  }

  #withNetworkLock(
    networkId: number,
    work: () => Promise<void>,
  ): Promise<void> {
    const network = this.#routeContext(networkId)?.networkLabel ?? networkId;
    return this.#exclusive(`weblounge-push-route-${network}`, work);
  }

  async #routeRequired(
    networkId: number,
    vapid: string,
    previousRouteId?: string,
  ): Promise<void> {
    const context = this.#routeContext(networkId);
    if (context === undefined) return;
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
    const routes = await this.#routes.all();
    for (const route of routes) {
      if (
        route.retiring === true &&
        route.networkLabel === context.networkLabel
      ) {
        if (!(await this.#unregisterRouteEngine(networkId, route))) return;
        if (!(await this.#retire(route, device))) return;
      }
    }
    const matching = routes.filter(
      (route) =>
        route.retiring !== true && route.networkLabel === context.networkLabel,
    );
    const ordered = [...matching].sort((left, right) =>
      left.routeId.localeCompare(right.routeId),
    );
    const selectedRouteId = this.#currentRoutes.get(networkId);
    const existing =
      ordered.find((route) => route.routeId === selectedRouteId) ??
      ordered.find((route) => route.routeId === previousRouteId) ??
      ordered.find(
        (route) => route.vapid === vapid && route.needsReregistration !== true,
      ) ??
      ordered[0];
    if (existing !== undefined) {
      this.#currentRoutes.set(networkId, existing.routeId);
    }
    for (const duplicate of matching) {
      if (duplicate.routeId !== existing?.routeId) {
        if (!(await this.#retireStale(networkId, duplicate, device))) return;
      }
    }
    if (
      existing !== undefined &&
      existing.vapid === vapid &&
      existing.needsReregistration !== true
    ) {
      this.#publish(networkId, "probing", existing.routeId);
      const current = await this.#refreshContext(
        existing,
        networkId,
        context,
        device.id,
      );
      await this.#register(networkId, current);
      return;
    }
    if (existing !== undefined) {
      if (!(await this.#unregisterRouteEngine(networkId, existing))) return;
      if (!(await this.#retire(existing, device))) return;
    } else if (
      previousRouteId !== undefined &&
      !(await this.#unregisterCurrentEngine(networkId))
    ) {
      return;
    }
    await this.#createAndRegister(networkId, context, vapid, device);
  }

  async #createAndRegister(
    networkId: number,
    context: PushRouteContext,
    vapid: string,
    device: RelayDevice,
    lastError?: string,
  ): Promise<void> {
    const keys = await this.#generateRouteKeys();
    const created = await this.#relay.createRoute(device, vapid);
    if (!created.ok) {
      this.#publish(
        networkId,
        "none",
        undefined,
        relayError("create", created.error),
      );
      if (created.error.kind === "unauthorized")
        await this.#authorizationFailed();
      return;
    }
    const route = storedRoute(
      networkId,
      context,
      vapid,
      keys,
      created.value,
      device.id,
    );
    await this.#routes.put(route);
    this.#publish(networkId, "probing", route.routeId, lastError);
    await this.#register(networkId, route);
  }

  async #refreshContext(
    route: StoredPushRoute,
    networkId: number,
    context: PushRouteContext,
    deviceId: string,
  ): Promise<StoredPushRoute> {
    if (
      route.networkId === networkId &&
      route.networkLabel === context.networkLabel &&
      route.nickname === context.nickname &&
      route.deviceId === deviceId
    ) {
      return route;
    }
    const current = { ...route, ...context, networkId, deviceId };
    await this.#routes.put(current);
    return current;
  }

  async #register(networkId: number, route: StoredPushRoute): Promise<void> {
    this.#currentRoutes.set(networkId, route.routeId);
    try {
      await this.#engine.send({
        id: crypto.randomUUID(),
        request: {
          type: "register_push",
          network_id: networkId,
          route: {
            route_id: route.routeId,
            endpoint: route.endpoint,
            p256dh: route.p256dh,
            auth: route.auth,
          },
        },
      });
    } catch {
      this.#publish(networkId, "probing", route.routeId, "engine: request");
    }
  }

  async #activate(networkId: number, routeId: string): Promise<void> {
    const [device, route] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.get(routeId),
    ]);
    if (
      device === undefined ||
      route === undefined ||
      route.retiring === true
    ) {
      this.#publish(networkId, "none", undefined, "activate: route missing");
      return;
    }
    const activated = await this.#relay.activateRoute(
      asRelayDevice(device),
      routeId,
    );
    if (activated.ok) {
      this.#publish(networkId, "active", routeId);
      return;
    }
    this.#publish(
      networkId,
      activated.error.kind === "dead_route" ? "dead" : "probing",
      routeId,
      relayError("activate", activated.error),
    );
    if (activated.error.kind === "unauthorized") {
      await this.#authorizationFailed();
    } else if (activated.error.kind === "dead_route") {
      if (!(await this.#unregisterRouteEngine(networkId, route))) return;
      if (!(await this.#retire(route, asRelayDevice(device)))) return;
      const context = this.#routeContext(networkId);
      if (context !== undefined) {
        await this.#createAndRegister(
          networkId,
          context,
          route.vapid,
          asRelayDevice(device),
          relayError("activate", activated.error),
        );
      }
    }
  }

  async #recoverRegistration(
    networkId: number,
    failedRouteId: string,
    reason: string,
    stateVersion: number,
  ): Promise<void> {
    const lastError = `engine: ${reason}`;
    const context = this.#routeContext(networkId);
    const route = await this.#routes.get(failedRouteId);
    const currentRouteId = this.#currentRoutes.get(networkId);
    if (this.#pushStateVersions.get(networkId) !== stateVersion) {
      if (
        route !== undefined &&
        currentRouteId !== undefined &&
        currentRouteId !== failedRouteId
      ) {
        await this.#retireSupersededFailure(networkId, route);
      }
      return;
    }
    this.#publish(
      networkId,
      route === undefined ? "none" : "probing",
      route?.routeId,
      lastError,
    );
    if (route === undefined) {
      if (!(await this.#unregisterCurrentEngine(networkId))) return;
    } else if (!(await this.#unregisterRouteEngine(networkId, route))) {
      return;
    }
    if (route === undefined || context === undefined) return;

    const device = await this.#devices.load(this.#relayOrigin);
    if (device === undefined) {
      await this.#routes.put({ ...route, retiring: true });
      this.#publish(networkId, "none", undefined, lastError);
      return;
    }
    if (!(await this.#retire(route, asRelayDevice(device)))) return;
    if (
      this.#pushStateVersions.get(networkId) !== stateVersion ||
      this.#currentRoutes.has(networkId)
    ) {
      return;
    }
    this.#publish(networkId, "none", undefined, lastError);

    if (reason !== "invalid_parameters") return;
    const recoveries = this.#registrationRecoveries.get(networkId) ?? 0;
    if (recoveries >= 1) return;
    this.#registrationRecoveries.set(networkId, recoveries + 1);
    await this.#createAndRegister(
      networkId,
      context,
      route.vapid,
      asRelayDevice(device),
      lastError,
    );
  }

  async #retireSupersededFailure(
    networkId: number,
    route: StoredPushRoute,
  ): Promise<void> {
    if (!(await this.#unregisterRouteEngine(networkId, route))) return;
    const device = await this.#devices.load(this.#relayOrigin);
    if (device === undefined) {
      await this.#routes.put({ ...route, retiring: true });
      return;
    }
    await this.#retire(route, asRelayDevice(device));
  }

  async #unregisterCurrentEngine(networkId: number): Promise<boolean> {
    this.#unregistering.add(networkId);
    try {
      await this.#engine.send({
        id: crypto.randomUUID(),
        request: { type: "unregister_push", network_id: networkId },
      });
      this.#currentRoutes.delete(networkId);
      return true;
    } catch {
      return false;
    } finally {
      this.#unregistering.delete(networkId);
    }
  }

  async #unregisterRouteEngine(
    networkId: number,
    route: StoredPushRoute,
  ): Promise<boolean> {
    this.#unregistering.add(networkId);
    try {
      await this.#engine.send({
        id: crypto.randomUUID(),
        request: {
          type: "unregister_push_route",
          network_id: networkId,
          route_id: route.routeId,
          endpoint: route.endpoint,
        },
      });
      if (this.#currentRoutes.get(networkId) === route.routeId) {
        this.#currentRoutes.delete(networkId);
      }
      return true;
    } catch {
      return false;
    } finally {
      this.#unregistering.delete(networkId);
    }
  }

  async #retireStale(
    networkId: number,
    route: StoredPushRoute,
    device: RelayDevice,
  ): Promise<boolean> {
    if (this.#currentRoutes.get(networkId) === route.routeId) return false;
    if (!(await this.#unregisterRouteEngine(networkId, route))) return false;
    return this.#retire(route, device);
  }

  async #dropRoute(networkId: number, unregister: boolean): Promise<void> {
    const [device, routes] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.all(),
    ]);
    const context = this.#routeContext(networkId);
    let matched = false;
    for (const route of routes) {
      if (
        route.retiring !== true &&
        (context === undefined
          ? route.networkId === networkId
          : route.networkLabel === context.networkLabel)
      ) {
        matched = true;
        if (
          unregister &&
          !(await this.#unregisterRouteEngine(networkId, route))
        ) {
          return;
        }
        if (device === undefined) {
          await this.#routes.put({ ...route, retiring: true });
          this.#publish(networkId, "probing", route.routeId);
        } else if (!(await this.#retire(route, asRelayDevice(device)))) {
          return;
        } else if ((await this.#routes.get(route.routeId)) !== undefined) {
          return;
        }
      }
    }
    if (
      unregister &&
      !matched &&
      !(await this.#unregisterCurrentEngine(networkId))
    ) {
      return;
    }
    if (!matched || device !== undefined) this.#publish(networkId, "none");
  }

  async #retire(route: StoredPushRoute, device: RelayDevice): Promise<boolean> {
    const retiring = {
      ...route,
      deviceId: route.deviceId ?? device.id,
      retiring: true,
    };
    await this.#routes.put(retiring);
    if (route.deviceId !== undefined && route.deviceId !== device.id) {
      return true;
    }
    const deleted = await this.#relay.deleteRoute(device, route.routeId);
    if (deleted.ok || deleted.error.kind === "dead_route") {
      await this.#routes.delete(route.routeId);
      return true;
    }
    this.#publish(
      route.networkId,
      "probing",
      route.routeId,
      relayError("delete", deleted.error),
    );
    if (deleted.error.kind === "unauthorized") {
      await this.#authorizationFailed();
      return false;
    }
    return true;
  }

  #ensureDevice(): Promise<RelayResult<RelayDevice>> {
    return this.#exclusive("weblounge-push-device", async () => {
      const stored = await this.#devices.load(this.#relayOrigin);
      if (stored !== undefined) {
        const device = asRelayDevice(stored);
        this.#onDeviceReady(device);
        return { ok: true, value: device };
      }
      const sessionToken = await this.#acquireSessionToken();
      const created = await this.#relay.createDevice(
        sessionToken,
        this.#target,
      );
      if (!created.ok) {
        if (created.error.kind === "unauthorized")
          this.#onAuthorizationRequired();
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

  async #authorizationFailed(): Promise<void> {
    const [routes, device] = await Promise.all([
      this.#routes.all(),
      this.#devices.load(this.#relayOrigin),
    ]);
    await Promise.all(
      routes.map((route) =>
        this.#routes.put({
          ...route,
          ...(route.deviceId === undefined && device !== undefined
            ? { deviceId: device.device_id }
            : {}),
          retiring: true,
        }),
      ),
    );
    await this.#devices.clear(this.#relayOrigin);
    this.#onAuthorizationRequired();
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

function relayError(operation: string, failure: RelayFailure): string {
  return `${operation}: ${failure.kind}`;
}

function storedRoute(
  networkId: number,
  context: PushRouteContext,
  vapid: string,
  keys: RouteKeys,
  route: RelayRoute,
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

function asRelayDevice(credentials: PushDeviceCredentials): RelayDevice {
  return { id: credentials.device_id, secret: credentials.secret };
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
