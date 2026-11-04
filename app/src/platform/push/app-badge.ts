import type { BufferProjection } from "../../engine/protocol";
import {
  type ConversationNotificationCount,
  writeNotificationCounts,
} from "./push-database";

interface BadgeNavigator {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

interface NotificationRegistration {
  getNotifications(filter?: GetNotificationOptions): Promise<Notification[]>;
}

interface RegistrationProvider {
  getRegistration(
    scope?: string,
  ): Promise<NotificationRegistration | undefined>;
}

export function appBadgeCount(buffers: readonly BufferProjection[]): number {
  return buffers.reduce(
    (count, buffer) =>
      count + (buffer.kind === "direct" ? buffer.unread : buffer.mentions),
    0,
  );
}

export function conversationNotificationCounts(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
): readonly ConversationNotificationCount[] {
  return buffers
    .filter(
      (buffer) =>
        buffer.kind !== "server" && networkLabels.has(buffer.network_id),
    )
    .map((buffer) => ({
      tag: `${networkLabels.get(buffer.network_id)}/${buffer.title.toLowerCase()}`,
      count: buffer.kind === "direct" ? buffer.unread : buffer.mentions,
    }));
}

export async function syncAppBadge(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
  badgeNavigator: BadgeNavigator = navigator,
): Promise<void> {
  const count = appBadgeCount(buffers);
  await writeNotificationCounts(
    conversationNotificationCounts(buffers, networkLabels),
  );
  if (count === 0) {
    await badgeNavigator.clearAppBadge?.();
    return;
  }
  await badgeNavigator.setAppBadge?.(count);
}

export async function syncAppPushState(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
  badgeNavigator: BadgeNavigator = navigator,
  registrations: RegistrationProvider = navigator.serviceWorker,
): Promise<void> {
  await Promise.all([
    syncAppBadge(buffers, networkLabels, badgeNavigator),
    closeReadConversationNotifications(buffers, networkLabels, registrations),
  ]);
}

export async function closeReadConversationNotifications(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
  registrations: RegistrationProvider = navigator.serviceWorker,
): Promise<void> {
  const readTags = conversationNotificationCounts(buffers, networkLabels)
    .filter(({ count }) => count === 0)
    .map(({ tag }) => tag);
  const registration = await registrations.getRegistration("/");
  const notificationGroups =
    registration === undefined
      ? []
      : await Promise.all(
          readTags.map((tag) => registration.getNotifications({ tag })),
        );
  for (const notification of notificationGroups.flat()) notification.close();
}
