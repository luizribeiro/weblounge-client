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
        routes.map((route) =>
          this.#relay.deleteRoute(asRelayDevice(device), route.routeId),
        ),
      );
    }
    await Promise.all(
      routes.map((route) => this.#routes.delete(route.networkId)),
    );
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
    return this.#exclusive(`weblounge-push-route-${networkId}`, work);
  }

  async #routeRequired(
    networkId: number,
    vapid: string,
    previousRouteId?: string,
  ): Promise<void> {
    const device = await this.#ensureDevice();
    if (device === undefined) return;
    const existing = await this.#routes.get(networkId);
    if (
      existing !== undefined &&
      existing.vapid === vapid &&
      existing.needsReregistration !== true
    ) {
      const current = await this.#refreshContext(existing);
      await this.#register(networkId, current);
      return;
    }
    if (existing !== undefined || previousRouteId !== undefined) {
      const routeId = existing?.routeId ?? previousRouteId;
      if (routeId !== undefined) {
        const deleted = await this.#relay.deleteRoute(device, routeId);
        if (!deleted.ok && deleted.error.kind === "unauthorized") {
          await this.#authorizationFailed();
          return;
        }
      }
      await this.#routes.delete(networkId);
    }
    await this.#createAndRegister(networkId, vapid, device);
  }

  async #createAndRegister(
    networkId: number,
    vapid: string,
    device: RelayDevice,
  ): Promise<void> {
    const context = this.#routeContext(networkId);
    if (context === undefined) return;
    const keys = await this.#generateRouteKeys();
    const created = await this.#relay.createRoute(device, vapid);
    if (!created.ok) {
      if (created.error.kind === "unauthorized")
        await this.#authorizationFailed();
      return;
    }
    const route = storedRoute(networkId, context, vapid, keys, created.value);
    await this.#routes.put(route);
    await this.#register(networkId, route);
  }

  async #refreshContext(route: StoredPushRoute): Promise<StoredPushRoute> {
    const context = this.#routeContext(route.networkId);
    if (
      context === undefined ||
      (route.networkLabel === context.networkLabel &&
        route.nickname === context.nickname)
    ) {
      return route;
    }
    const current = { ...route, ...context };
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
      this.#routes.get(networkId),
    ]);
    if (
      device === undefined ||
      route === undefined ||
      route.routeId !== routeId
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
      await this.#routes.delete(networkId);
      await this.#createAndRegister(
        networkId,
        route.vapid,
        asRelayDevice(device),
      );
    }
  }

  async #dropRoute(networkId: number): Promise<void> {
    const [device, route] = await Promise.all([
      this.#devices.load(this.#relayOrigin),
      this.#routes.get(networkId),
    ]);
    if (route === undefined) return;
    if (device !== undefined) {
      const deleted = await this.#relay.deleteRoute(
        asRelayDevice(device),
        route.routeId,
      );
      if (!deleted.ok && deleted.error.kind === "unauthorized") {
        await this.#authorizationFailed();
        return;
      }
    }
    await this.#routes.delete(networkId);
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
    const routes = await this.#routes.all();
    await Promise.all(
      routes.map((route) => this.#routes.delete(route.networkId)),
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
): StoredPushRoute {
  return {
    networkId,
    ...context,
    vapid,
    routeId: route.id,
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
