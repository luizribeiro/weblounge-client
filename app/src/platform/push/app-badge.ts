import type { BufferProjection } from "../../engine/protocol";
import { conversationTag } from "../page-notifications/page-notification-format";
import {
  type ConversationNotificationCount,
  writeNotificationCounts,
} from "./push-database";
import { notificationDataIsRead } from "./push-notification-state";

export interface BadgeNavigator {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
}

export type DeliveredNotification = Pick<Notification, "data" | "close">;

interface NotificationRegistration {
  getNotifications(): Promise<readonly DeliveredNotification[]>;
}

export interface RegistrationProvider {
  getRegistration(
    scope?: string,
  ): Promise<NotificationRegistration | undefined>;
}

/** Where the host keeps the badge, the delivered notifications and the counts pushes start from. */
export interface NotificationCenter {
  readonly badge: BadgeNavigator;
  readonly registrations: RegistrationProvider;
  writeCounts(counts: readonly ConversationNotificationCount[]): Promise<void>;
}

export function webNotificationCenter(): NotificationCenter {
  return {
    badge: navigator,
    registrations: navigator.serviceWorker,
    writeCounts: writeNotificationCounts,
  };
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
  center: Pick<NotificationCenter, "badge" | "writeCounts">,
): Promise<void> {
  const count = appBadgeCount(buffers);
  await center.writeCounts(
    conversationNotificationCounts(buffers, networkLabels),
  );
  if (count === 0) {
    await center.badge.clearAppBadge?.();
    return;
  }
  await center.badge.setAppBadge?.(count);
}

export async function syncAppPushState(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
  center: NotificationCenter,
): Promise<void> {
  await Promise.all([
    syncAppBadge(buffers, networkLabels, center),
    closeReadConversationNotifications(
      buffers,
      networkLabels,
      center.registrations,
    ),
  ]);
}

export async function closeReadConversationNotifications(
  buffers: readonly BufferProjection[],
  networkLabels: ReadonlyMap<number, string>,
  registrations: RegistrationProvider,
): Promise<void> {
  const readMarkers = conversationReadMarkers(buffers, networkLabels);
  const registration = await registrations.getRegistration("/");
  const notifications = await registration?.getNotifications();
  for (const notification of notifications ?? []) {
    if (notificationDataIsRead(notification.data, readMarkers))
      notification.close();
  }
}

/** Withdraws pushed notifications whose message was deleted. */
export async function closeMessageNotifications(
  msgids: readonly string[],
  registrations: RegistrationProvider,
): Promise<void> {
  const registration = await registrations.getRegistration("/");
  const notifications = await registration?.getNotifications();
  for (const notification of notifications ?? []) {
    const data: unknown = notification.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "messageId" in data &&
      typeof data.messageId === "string" &&
      msgids.includes(data.messageId)
    )
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
