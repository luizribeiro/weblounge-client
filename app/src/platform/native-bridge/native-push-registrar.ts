import { type PushRegistrar, webPushRegistrar } from "../push/push-registrar";
import { IndexedDbPushRouteStore } from "../push/route-store";
import { type NativeBridge, nativeBridge } from "./native-bridge";
import {
  NativeKeyedRouteStore,
  nativeRouteKeyFactory,
} from "./native-route-keys";
import { observeNativePageEvents } from "./page-events";

export function hostPushRegistrar(
  bridge: NativeBridge | undefined = nativeBridge(),
): PushRegistrar {
  return bridge === undefined
    ? webPushRegistrar()
    : nativePushRegistrar(bridge);
}

/** Registers the iPhone app's APNs token, with route keys kept in the shell's keychain. */
export function nativePushRegistrar(bridge: NativeBridge): PushRegistrar {
  const permission = () => bridge.call("push_permission");
  return {
    native: true,
    supported: () => true,
    permission,
    requestPermission: () => bridge.call("request_push_permission"),
    target: async () => {
      if ((await permission()) !== "granted")
        return { status: "permission_not_granted" };
      const target = await bridge.call("push_target");
      return target === null
        ? { status: "unavailable" }
        : { status: "ready", target };
    },
    generateRouteKeys: nativeRouteKeyFactory(bridge),
    routes: () =>
      new NativeKeyedRouteStore(new IndexedDbPushRouteStore(), bridge),
    routesNeedingReregistration: () =>
      bridge.call("routes_needing_reregistration"),
    onTargetChange: (listener) =>
      observeNativePageEvents(window, {
        "weblounge:push-target": () => listener(),
      }),
  };
}
