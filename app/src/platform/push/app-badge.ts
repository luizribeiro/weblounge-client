import type { BufferProjection } from "../../engine/protocol";
import {
  type ConversationNotificationCount,
  writeNotificationCounts,
} from "./push-database";
import { conversationTag } from "./push-notification";
import { notificationDataIsRead } from "./push-notification-state";

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
    (count, buffer) => count + knownNotificationCount(buffer),
    0,
  );
}

export function conversationNotificationCounts(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
): readonly ConversationNotificationCount[] {
  return buffers.flatMap((buffer) => {
    const networkLabel = networkLabels.get(buffer.network_id);
    if (buffer.kind === "server" || networkLabel === undefined) return [];
    return [
      {
        tag: conversationTag(networkLabel, buffer.title),
        count: knownNotificationCount(buffer),
        ...(buffer.read_at_ms === undefined
          ? {}
          : { readAtMs: buffer.read_at_ms }),
      },
    ];
  });
}

function knownNotificationCount(buffer: BufferProjection): number {
  // Direct-message mention facts include every unread peer message and stay exact across gaps.
  return buffer.kind === "server" ? 0 : buffer.mentions;
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
  const readMarkers = conversationReadMarkers(buffers, networkLabels);
  const registration = await registrations.getRegistration("/");
  const notifications = await registration?.getNotifications();
  for (const notification of notifications ?? []) {
    if (notificationDataIsRead(notification.data, readMarkers))
      notification.close();
  }
}

export function conversationReadMarkers(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
): ReadonlyMap<string, number> {
  return new Map(
    conversationNotificationCounts(buffers, networkLabels).flatMap(
      ({ tag, readAtMs }) =>
        readAtMs === undefined ? [] : [[tag, readAtMs] as const],
    ),
  );
}
