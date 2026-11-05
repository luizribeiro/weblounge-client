import { notificationDataIsRead } from "./push-notification-state";

interface CloseableNotification {
  readonly data: unknown;
  close(): void;
}

interface FallbackIdentity {
  readonly conversationTag: string;
  readonly fallbackId: string;
}

interface NotificationIdentity {
  readonly tag: string;
  readonly messageId: string;
  readonly messageTime: string;
}

export async function closeNotificationsCoveredByMarkers(
  notifications: () => Promise<readonly CloseableNotification[]>,
  readMarkers: ReadonlyMap<string, number>,
): Promise<void> {
  const candidates = await notifications();
  for (const candidate of candidates) {
    const identity = notificationIdentity(candidate.data);
    if (
      identity === undefined ||
      !notificationDataIsRead(candidate.data, readMarkers)
    ) {
      continue;
    }
    const current = (await notifications()).find((notification) =>
      sameNotification(notification.data, identity),
    );
    if (
      current !== undefined &&
      notificationDataIsRead(current.data, readMarkers)
    ) {
      current.close();
    }
  }
}

export async function closeSupersededFallbackNotifications(
  notifications: () => Promise<readonly CloseableNotification[]>,
  conversationTag: string,
  currentReceiptId: string,
  pendingFallbacks: ReadonlySet<string>,
): Promise<void> {
  const candidates = await notifications();
  for (const candidate of candidates) {
    const identity = fallbackIdentity(candidate.data);
    if (
      identity === undefined ||
      identity.conversationTag !== conversationTag ||
      identity.fallbackId === currentReceiptId ||
      pendingFallbacks.has(identity.fallbackId)
    ) {
      continue;
    }
    const current = (await notifications()).find((notification) =>
      sameFallback(notification.data, identity),
    );
    if (current !== undefined) current.close();
  }
}

function notificationIdentity(data: unknown): NotificationIdentity | undefined {
  if (
    typeof data !== "object" ||
    data === null ||
    !("conversationTag" in data) ||
    typeof data.conversationTag !== "string" ||
    !("messageId" in data) ||
    typeof data.messageId !== "string" ||
    !("messageTime" in data) ||
    typeof data.messageTime !== "string"
  ) {
    return undefined;
  }
  return {
    tag: data.conversationTag,
    messageId: data.messageId,
    messageTime: data.messageTime,
  };
}

function sameNotification(
  data: unknown,
  identity: NotificationIdentity,
): boolean {
  const current = notificationIdentity(data);
  return (
    current !== undefined &&
    current.tag === identity.tag &&
    current.messageId === identity.messageId &&
    current.messageTime === identity.messageTime
  );
}

function fallbackIdentity(data: unknown): FallbackIdentity | undefined {
  if (
    typeof data !== "object" ||
    data === null ||
    !("conversationTag" in data) ||
    typeof data.conversationTag !== "string" ||
    !("fallbackId" in data) ||
    typeof data.fallbackId !== "string"
  ) {
    return undefined;
  }
  return {
    conversationTag: data.conversationTag,
    fallbackId: data.fallbackId,
  };
}

function sameFallback(data: unknown, identity: FallbackIdentity): boolean {
  const current = fallbackIdentity(data);
  return (
    current !== undefined &&
    current.conversationTag === identity.conversationTag &&
    current.fallbackId === identity.fallbackId
  );
}
