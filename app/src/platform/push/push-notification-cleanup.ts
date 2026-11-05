import { notificationDataIsRead } from "./push-notification-state";

const notificationScanLimit = 64;

interface CloseableNotification {
  readonly data: unknown;
  close(): void | Promise<void>;
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

interface ConversationIdentity {
  readonly conversationTag?: string;
  readonly fallbackId?: string;
  readonly messageId?: string;
  readonly messageTime?: string;
  readonly receiptId?: string;
}

export interface CurrentConversationNotification {
  readonly receiptId: string;
  readonly messageId: string;
  readonly messageTime: string;
}

export async function closeNotificationsCoveredByMarkers(
  notifications: () => Promise<readonly CloseableNotification[]>,
  readMarkers: ReadonlyMap<string, number>,
): Promise<void> {
  const candidates = await notificationSnapshot(notifications);
  const currentNotifications = await notificationSnapshot(notifications);
  for (const candidate of candidates) {
    const identity = notificationIdentity(candidate.data);
    if (
      identity === undefined ||
      !notificationDataIsRead(candidate.data, readMarkers)
    ) {
      continue;
    }
    const current = currentNotifications.find((notification) =>
      sameNotification(notification.data, identity),
    );
    if (
      current !== undefined &&
      notificationDataIsRead(current.data, readMarkers)
    ) {
      await current.close();
    }
  }
}

export async function closeSupersededFallbackNotifications(
  notifications: () => Promise<readonly CloseableNotification[]>,
  conversationTag: string,
  currentReceiptId: string,
  pendingFallbacks: ReadonlySet<string>,
): Promise<void> {
  const candidates = await notificationSnapshot(notifications);
  const currentNotifications = await notificationSnapshot(notifications);
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
    const current = currentNotifications.find((notification) =>
      sameFallback(notification.data, identity),
    );
    if (current !== undefined) await current.close();
  }
}

export async function closeSupersededConversationNotifications(
  notifications: () => Promise<readonly CloseableNotification[]>,
  conversationTag: string,
  currentNotification: CurrentConversationNotification,
  pendingReceipts: ReadonlySet<string>,
): Promise<void> {
  const candidates = await notificationSnapshot(notifications);
  const currentNotifications = await notificationSnapshot(notifications);
  const relatedFallbacks = new Set(
    currentNotifications.flatMap((notification) => {
      const identity = conversationIdentity(notification.data);
      return identity?.conversationTag === conversationTag &&
        identity.fallbackId !== undefined
        ? [identity.fallbackId]
        : [];
    }),
  );
  const currentReceiptIsVisible = currentNotifications.some(
    (notification) =>
      conversationIdentity(notification.data)?.receiptId ===
      currentNotification.receiptId,
  );
  for (const candidate of candidates) {
    const identity = conversationIdentity(candidate.data);
    if (
      identity === undefined ||
      !belongsToConversation(identity, conversationTag, relatedFallbacks) ||
      isProtectedReceipt(
        identity,
        currentNotification,
        currentReceiptIsVisible,
        pendingReceipts,
      )
    ) {
      continue;
    }
    const current = currentNotifications.find((notification) =>
      sameConversationNotification(notification.data, identity),
    );
    if (current !== undefined) await current.close();
  }
}

async function notificationSnapshot(
  notifications: () => Promise<readonly CloseableNotification[]>,
): Promise<readonly CloseableNotification[]> {
  return (await notifications()).slice(0, notificationScanLimit);
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

function conversationIdentity(data: unknown): ConversationIdentity | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const identity: ConversationIdentity = {
    ...stringField(data, "conversationTag"),
    ...stringField(data, "fallbackId"),
    ...stringField(data, "messageId"),
    ...stringField(data, "messageTime"),
    ...stringField(data, "receiptId"),
  };
  return Object.keys(identity).length === 0 ? undefined : identity;
}

function stringField(
  data: object,
  key: keyof ConversationIdentity,
): Partial<ConversationIdentity> {
  const value = Reflect.get(data, key);
  return typeof value === "string" ? { [key]: value } : {};
}

function belongsToConversation(
  identity: ConversationIdentity,
  conversationTag: string,
  relatedFallbacks: ReadonlySet<string>,
): boolean {
  return (
    identity.conversationTag === conversationTag ||
    (identity.conversationTag === undefined &&
      identity.fallbackId !== undefined &&
      relatedFallbacks.has(identity.fallbackId))
  );
}

function isProtectedReceipt(
  identity: ConversationIdentity,
  current: CurrentConversationNotification,
  currentReceiptIsVisible: boolean,
  pendingReceipts: ReadonlySet<string>,
): boolean {
  const detailed = identity.conversationTag !== undefined;
  return (
    detailed &&
    (identity.receiptId === current.receiptId ||
      (identity.receiptId !== undefined &&
        pendingReceipts.has(identity.receiptId)) ||
      (!currentReceiptIsVisible &&
        identity.messageId === current.messageId &&
        identity.messageTime === current.messageTime))
  );
}

function sameConversationNotification(
  data: unknown,
  identity: ConversationIdentity,
): boolean {
  const current = conversationIdentity(data);
  return (
    current !== undefined &&
    current.conversationTag === identity.conversationTag &&
    current.fallbackId === identity.fallbackId &&
    current.messageId === identity.messageId &&
    current.messageTime === identity.messageTime &&
    current.receiptId === identity.receiptId
  );
}
