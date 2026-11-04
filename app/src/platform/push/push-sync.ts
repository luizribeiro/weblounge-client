import type { EngineClient } from "../../engine/EngineClient";
import type { PushDeviceCredentials } from "../../engine/generated/PushDeviceCredentials";
import type { EngineClientMessage } from "../../engine/protocol";
import type { PushDeviceStore } from "./engine-device-store";
import type { RelayClient, RelayDevice, RelayRoute } from "./relay-client";
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
  readonly onDeviceReady?: (device: RelayDevice) => void;
  readonly generateRouteKeys?: () => Promise<RouteKeys>;
  readonly exclusive?: <T>(name: string, work: () => Promise<T>) => Promise<T>;
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
  readonly #onDeviceReady: (device: RelayDevice) => void;
  readonly #generateRouteKeys: () => Promise<RouteKeys>;
  readonly #exclusive: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  readonly #unsubscribe: () => void;
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
    this.#onDeviceReady = options.onDeviceReady ?? (() => {});
    this.#generateRouteKeys = options.generateRouteKeys ?? createRouteKeys;
    this.#exclusive = options.exclusive ?? withExclusiveLock;
    this.#unsubscribe = this.#engine.subscribe((message) =>
      this.handle(message),
    );
    this.#enqueue(() => this.#retryRetiringRoutes());
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
    await this.#engine.send({
      id: crypto.randomUUID(),
      request: { type: "unregister_push", network_id: networkId },
    });
    await this.#dropRoute(networkId);
  }

  async signOut(): Promise<void> {
    const device = await this.#devices.load(this.#relayOrigin);
    const routes = await this.#routes.all();
    if (device !== undefined) {
      await Promise.all(
        routes.map((route) => this.#retire(route, asRelayDevice(device))),
      );
    } else {
      await Promise.all(
        routes.map((route) => this.#routes.put({ ...route, retiring: true })),
      );
    }
    await this.#devices.clear(this.#relayOrigin);
  }

  #onEngineMessage(message: EngineClientMessage): void {
    if (message.type === "push_route_required") {
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
    if (message.state.status === "registered") {
      const routeId = message.state.route_id;
      this.#enqueue(() =>
        this.#withNetworkLock(message.network_id, () =>
          this.#activate(message.network_id, routeId),
        ),
      );
    } else if (
      message.state.status === "failed" ||
      message.state.status === "unsupported"
    ) {
      this.#enqueue(() =>
        this.#withNetworkLock(message.network_id, () =>
          this.#dropRoute(message.network_id),
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
    const device = await this.#ensureDevice();
    if (device === undefined) return;
    const routes = await this.#routes.all();
    const matching = routes.filter(
      (route) =>
        route.retiring !== true && route.networkLabel === context.networkLabel,
    );
    const existing =
      matching.find((route) => route.routeId === previousRouteId) ??
      matching[0];
    for (const duplicate of matching) {
      if (duplicate.routeId !== existing?.routeId) {
        if (!(await this.#retire(duplicate, device))) return;
      }
    }
    if (
      existing !== undefined &&
      existing.vapid === vapid &&
      existing.needsReregistration !== true
    ) {
      const current = await this.#refreshContext(
        existing,
        networkId,
        context,
        device.id,
      );
      await this.#register(networkId, current);
      return;
    }
    if (existing !== undefined || previousRouteId !== undefined) {
      const previous =
        existing ??
        (previousRouteId === undefined
          ? undefined
          : await this.#routes.get(previousRouteId));
      if (previous !== undefined && !(await this.#retire(previous, device))) {
        return;
      }
    }
    await this.#createAndRegister(networkId, context, vapid, device);
  }

  async #createAndRegister(
    networkId: number,
    context: PushRouteContext,
    vapid: string,
    device: RelayDevice,
  ): Promise<void> {
    const keys = await this.#generateRouteKeys();
    const created = await this.#relay.createRoute(device, vapid);
    if (!created.ok) {
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
      return;
    }
    const activated = await this.#relay.activateRoute(
      asRelayDevice(device),
      routeId,
    );
    if (activated.ok) return;
    if (activated.error.kind === "unauthorized") {
      await this.#authorizationFailed();
    } else if (activated.error.kind === "dead_route") {
      await this.#routes.delete(routeId);
      const context = this.#routeContext(networkId);
      if (context !== undefined) {
        await this.#createAndRegister(
          networkId,
          context,
          route.vapid,
          asRelayDevice(device),
        );
      }
    }
  }

  async #dropRoute(networkId: number): Promise<void> {
    const [device, routes] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.all(),
    ]);
    const context = this.#routeContext(networkId);
    if (context === undefined) return;
    for (const route of routes) {
      if (
        route.retiring !== true &&
        route.networkLabel === context.networkLabel
      ) {
        if (device === undefined) {
          await this.#routes.put({ ...route, retiring: true });
        } else if (!(await this.#retire(route, asRelayDevice(device)))) {
          return;
        }
      }
    }
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
    if (deleted.error.kind === "unauthorized") {
      await this.#authorizationFailed();
      return false;
    }
    return true;
  }

  async #retryRetiringRoutes(): Promise<void> {
    const device = await this.#devices.load(this.#relayOrigin);
    if (device === undefined) return;
    for (const route of await this.#routes.all()) {
      if (
        route.retiring === true &&
        (route.deviceId === undefined || route.deviceId === device.device_id)
      ) {
        if (!(await this.#retire(route, asRelayDevice(device)))) return;
      }
    }
  }

  #ensureDevice(): Promise<RelayDevice | undefined> {
    return this.#exclusive("weblounge-push-device", async () => {
      const stored = await this.#devices.load(this.#relayOrigin);
      if (stored !== undefined) {
        const device = asRelayDevice(stored);
        this.#onDeviceReady(device);
        return device;
      }
      const sessionToken = await this.#acquireSessionToken();
      const created = await this.#relay.createDevice(
        sessionToken,
        this.#target,
      );
      if (!created.ok) {
        if (created.error.kind === "unauthorized")
          this.#onAuthorizationRequired();
        return undefined;
      }
      await this.#devices.store({
        relay: this.#relayOrigin,
        device_id: created.value.id,
        secret: created.value.secret,
      });
      this.#onDeviceReady(created.value);
      return created.value;
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
