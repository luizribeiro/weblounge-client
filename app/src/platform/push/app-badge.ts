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
      ...(buffer.read_at_ms === undefined
        ? {}
        : { readAtMs: buffer.read_at_ms }),
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
  const readMarkers = new Map(
    conversationNotificationCounts(buffers, networkLabels)
      .filter(
        (
          entry,
        ): entry is ConversationNotificationCount & {
          readonly readAtMs: number;
        } => entry.readAtMs !== undefined,
      )
      .map(({ tag, readAtMs }) => [tag, readAtMs]),
  );
  const registration = await registrations.getRegistration("/");
  const notifications = await registration?.getNotifications();
  for (const notification of notifications ?? []) {
    if (notificationIsRead(notification, readMarkers)) notification.close();
  }
}

function notificationIsRead(
  notification: Notification,
  readMarkers: ReadonlyMap<string, number>,
): boolean {
  const data: unknown = notification.data;
  if (typeof data !== "object" || data === null) return false;
  if (
    !("conversationTag" in data) ||
    typeof data.conversationTag !== "string" ||
    !("messageTime" in data) ||
    typeof data.messageTime !== "string"
  )
    return false;
  const marker = readMarkers.get(data.conversationTag);
  const messageTime = Date.parse(data.messageTime);
  return (
    marker !== undefined && !Number.isNaN(messageTime) && messageTime <= marker
  );
}
