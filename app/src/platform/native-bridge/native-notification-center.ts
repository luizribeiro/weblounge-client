import {
  type NotificationCenter,
  webNotificationCenter,
} from "../push/app-badge";
import type { DeliveredNotification } from "./generated/DeliveredNotification";
import { type NativeBridge, nativeBridge } from "./native-bridge";

export function hostNotificationCenter(
  bridge: NativeBridge | undefined = nativeBridge(),
): NotificationCenter {
  return bridge === undefined
    ? webNotificationCenter()
    : nativeNotificationCenter(bridge);
}

export function nativeNotificationCenter(
  bridge: NativeBridge,
): NotificationCenter {
  const setBadge = async (count: number) => {
    await bridge.call("set_badge", { count });
  };
  const closable = ({ identifier, data }: DeliveredNotification) => ({
    data,
    // Notification.close() can't fail either; the next sync retries anything still delivered.
    close: () => {
      void bridge
        .call("remove_delivered_notifications", { identifiers: [identifier] })
        .catch(() => undefined);
    },
  });
  return {
    badge: {
      setAppBadge: (count = 0) => setBadge(count),
      clearAppBadge: () => setBadge(0),
    },
    registrations: {
      getRegistration: async () => ({
        getNotifications: async () =>
          (await bridge.call("delivered_notifications")).map(closable),
      }),
    },
    writeCounts: async (counts) => {
      await bridge.call("write_notification_counts", { counts: [...counts] });
    },
  };
}
