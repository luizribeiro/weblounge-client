export interface ConversationNotificationState {
  unknown: number;
  readonly messages: Map<string, number>;
}

export interface NotificationState {
  readonly conversations: Map<string, ConversationNotificationState>;
  readonly readAtMs: Map<string, number>;
  untagged: number;
}

export interface PresentedNotification {
  readonly tag?: string;
  readonly messageId?: string;
  readonly messageTime?: string;
}

export interface NotificationCountSnapshot {
  readonly tag: string;
  readonly count: number;
  readonly readAtMs?: number;
}

export function recordPresentedNotification(
  state: NotificationState,
  presented: PresentedNotification,
): void {
  if (presented.tag === undefined || presented.tag.length === 0) {
    state.untagged += 1;
    return;
  }
  const conversation = state.conversations.get(presented.tag) ?? {
    unknown: 0,
    messages: new Map<string, number>(),
  };
  const messageTime =
    presented.messageTime === undefined
      ? undefined
      : Date.parse(presented.messageTime);
  if (
    presented.messageId === undefined ||
    messageTime === undefined ||
    Number.isNaN(messageTime)
  ) {
    conversation.unknown += 1;
  } else if ((state.readAtMs.get(presented.tag) ?? -1) >= messageTime) {
    state.conversations.set(presented.tag, conversation);
    return;
  } else if (!conversation.messages.has(presented.messageId)) {
    conversation.messages.set(presented.messageId, messageTime);
  }
  state.conversations.set(presented.tag, conversation);
  state.readAtMs.delete(presented.tag);
}

export function markConversationRead(
  state: NotificationState,
  tag: string,
  marker: number,
): void {
  const conversation = state.conversations.get(tag) ?? {
    unknown: 0,
    messages: new Map<string, number>(),
  };
  conversation.unknown = 0;
  for (const [id, time] of conversation.messages) {
    if (time <= marker) conversation.messages.delete(id);
  }
  state.conversations.set(tag, conversation);
  state.readAtMs.set(tag, Math.max(state.readAtMs.get(tag) ?? 0, marker));
}

export function notificationDataIsRead(
  data: unknown,
  readMarkers: ReadonlyMap<string, number>,
): boolean {
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

export function notificationStateTotal(state: NotificationState): number {
  return (
    state.untagged +
    [...state.conversations.values()].reduce(
      (total, conversation) =>
        total + conversation.unknown + conversation.messages.size,
      0,
    )
  );
}

export function replaceNotificationCounts(
  state: NotificationState,
  counts: readonly NotificationCountSnapshot[],
): void {
  const conversations = new Map<string, ConversationNotificationState>();
  const readAtMs = new Map<string, number>();
  for (const { tag, count, readAtMs: marker } of counts) {
    const cleanupMarker = state.readAtMs.get(tag);
    const known = [...(state.conversations.get(tag)?.messages ?? [])]
      .filter(([, time]) => marker === undefined || time > marker)
      .sort((left, right) => right[1] - left[1])
      .slice(0, count);
    conversations.set(tag, {
      unknown: Math.max(0, count - known.length),
      messages: new Map(known),
    });
    if (cleanupMarker !== undefined) readAtMs.set(tag, cleanupMarker);
  }
  state.conversations.clear();
  for (const [tag, conversation] of conversations) {
    state.conversations.set(tag, conversation);
  }
  state.readAtMs.clear();
  for (const [tag, marker] of readAtMs) state.readAtMs.set(tag, marker);
  state.untagged = 0;
}

export function decodeNotificationState(value: unknown): NotificationState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    (value.schema !== 1 && value.schema !== 2 && value.schema !== 3) ||
    !("conversations" in value) ||
    !Array.isArray(value.conversations) ||
    !("untagged" in value) ||
    !validCount(value.untagged)
  ) {
    return emptyNotificationState();
  }
  const conversations = new Map<string, ConversationNotificationState>();
  const readAtMs = new Map<string, number>();
  for (const entry of value.conversations) {
    if (value.schema === 1) {
      if (!isLegacyConversation(entry)) return emptyNotificationState();
      conversations.set(entry[0], {
        unknown: entry[1],
        messages: new Map(),
      });
      continue;
    }
    if (!isVersionedConversation(entry, value.schema)) {
      return emptyNotificationState();
    }
    const messages = new Map<string, number>();
    if (value.schema === 3) {
      for (const message of entry.messages) {
        if (
          typeof message !== "object" ||
          message === null ||
          !("id" in message) ||
          typeof message.id !== "string" ||
          !("time_ms" in message) ||
          !validReadMarker(message.time_ms)
        ) {
          return emptyNotificationState();
        }
        messages.set(message.id, message.time_ms);
      }
    }
    conversations.set(entry.tag, {
      unknown: value.schema === 2 ? entry.count : entry.unknown_count,
      messages,
    });
    if (entry.read_at_ms !== null) readAtMs.set(entry.tag, entry.read_at_ms);
  }
  return { conversations, readAtMs, untagged: value.untagged };
}

export function encodeNotificationState(state: NotificationState): unknown {
  return {
    schema: 3,
    conversations: [...state.conversations].map(([tag, conversation]) => ({
      tag,
      unknown_count: conversation.unknown,
      messages: [...conversation.messages].map(([id, time]) => ({
        id,
        time_ms: time,
      })),
      read_at_ms: state.readAtMs.get(tag) ?? null,
    })),
    untagged: state.untagged,
  };
}

export function emptyNotificationState(): NotificationState {
  return { conversations: new Map(), readAtMs: new Map(), untagged: 0 };
}

function isLegacyConversation(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    validCount(value[1])
  );
}

function isVersionedConversation(
  value: unknown,
  schema: 2 | 3,
): value is {
  readonly tag: string;
  readonly count: number;
  readonly unknown_count: number;
  readonly messages: readonly unknown[];
  readonly read_at_ms: number | null;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "tag" in value &&
    typeof value.tag === "string" &&
    (schema === 2
      ? "count" in value && validCount(value.count)
      : "unknown_count" in value &&
        validCount(value.unknown_count) &&
        "messages" in value &&
        Array.isArray(value.messages)) &&
    "read_at_ms" in value &&
    (value.read_at_ms === null || validReadMarker(value.read_at_ms))
  );
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validReadMarker(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
