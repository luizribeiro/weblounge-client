import type {
  PushRouteRecord,
  PushRouteStore,
  RouteKeyFactory,
  StoredPushRoute,
} from "../push/route-store";
import type { NativeBridge } from "./native-bridge";

/** Makes a route's keys in the shell's keychain, where the notification extension reads them. */
export function nativeRouteKeyFactory(bridge: NativeBridge): RouteKeyFactory {
  return async ({ routeId, networkId, networkLabel, nickname }) => {
    const keys = await bridge.call("create_route_keys", {
      routeId,
      route: { networkId, networkLabel, nickname },
    });
    return { ...keys, keyStorage: "native" };
  };
}

/** Forgets a route's keychain keys wherever the page forgets or replaces its route record. */
export class NativeKeyedRouteStore implements PushRouteStore {
  readonly #records: PushRouteStore;
  readonly #bridge: NativeBridge;

  constructor(records: PushRouteStore, bridge: NativeBridge) {
    this.#records = records;
    this.#bridge = bridge;
  }

  get(homeVapid: string): Promise<PushRouteRecord | undefined> {
    return this.#records.get(homeVapid);
  }

  findRoute(routeId: string): Promise<PushRouteRecord | undefined> {
    return this.#records.findRoute(routeId);
  }

  all(): Promise<readonly PushRouteRecord[]> {
    return this.#records.all();
  }

  async put(route: StoredPushRoute): Promise<void> {
    const replaced = await this.#records.get(route.vapid);
    await this.#records.put(route);
    if (replaced !== undefined && replaced.routeId !== route.routeId)
      await this.#drop(replaced);
  }

  async delete(homeVapid: string): Promise<void> {
    const deleted = await this.#records.get(homeVapid);
    await this.#records.delete(homeVapid);
    if (deleted !== undefined) await this.#drop(deleted);
  }

  async #drop(route: PushRouteRecord): Promise<void> {
    if (!("keyStorage" in route) || route.keyStorage !== "native") return;
    // A key left in the keychain decrypts nothing once the relay forgets its route, so a failed
    // drop must not stop the registration flow that forgot the record.
    await this.#bridge
      .call("drop_route_keys", { routeId: route.routeId })
      .catch(() => undefined);
  }
}
