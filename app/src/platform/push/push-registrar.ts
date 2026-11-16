import { supportsPageNotifications } from "../page-notifications/page-notification-capability";
import type { DeviceTarget } from "./device-target";
import {
  createRouteKeys,
  IndexedDbPushRouteStore,
  type PushRouteStore,
  type RouteKeyFactory,
} from "./route-store";
import { ensurePushSubscription } from "./subscription";

export type PushTargetResult =
  | { readonly status: "ready"; readonly target: DeviceTarget }
  | { readonly status: "permission_not_granted" }
  | { readonly status: "unavailable" };

/** How this host asks for push permission and gets the target and keys the relay delivers to. */
export interface PushRegistrar {
  /** The host's own shell offers push, so the page asks even where a browser couldn't. */
  readonly native: boolean;
  supported(): boolean;
  /** Reads the permission without asking. */
  permission(): Promise<NotificationPermission>;
  /** Asks; only a user's "Turn on" may call it. */
  requestPermission(): Promise<NotificationPermission>;
  target(relayVapid: string): Promise<PushTargetResult>;
  readonly generateRouteKeys: RouteKeyFactory;
  routes(): PushRouteStore;
  /** Calls `listener` when the host's target changes outside a registration. */
  onTargetChange(listener: () => void): () => void;
}

export function webPushRegistrar(): PushRegistrar {
  return {
    native: false,
    supported: () => supportsWebPush(window, navigator),
    permission: async () =>
      "Notification" in window ? Notification.permission : "default",
    requestPermission: () => Notification.requestPermission(),
    target: async (relayVapid) =>
      ensurePushSubscription(await navigator.serviceWorker.ready, relayVapid),
    generateRouteKeys: () => createRouteKeys(),
    routes: () => new IndexedDbPushRouteStore(),
    onTargetChange: (listener) => {
      const worker = navigator.serviceWorker;
      if (worker === undefined) return () => {};
      const onMessage = (event: MessageEvent<unknown>) => {
        if (isPushSubscriptionChange(event.data)) listener();
      };
      worker.addEventListener("message", onMessage);
      return () => worker.removeEventListener("message", onMessage);
    },
  };
}

function isPushSubscriptionChange(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "push_subscription_change"
  );
}

export function supportsWebPush(
  browserWindow: Window,
  browserNavigator: Navigator,
): boolean {
  return (
    supportsPageNotifications(browserWindow) &&
    "PushManager" in browserWindow &&
    "serviceWorker" in browserNavigator
  );
}
