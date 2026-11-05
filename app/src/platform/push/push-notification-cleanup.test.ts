import { describe, expect, it, vi } from "vitest";
import {
  closeNotificationsCoveredByMarkers,
  closeSupersededConversationNotifications,
  closeSupersededFallbackNotifications,
} from "./push-notification-cleanup";

const tag = "Lounge/#lounge";
const marker = Date.parse("2026-11-04T19:24:33.000Z");

describe("push notification cleanup", () => {
  it("does not close a same-tag replacement newer than MARKREAD", async () => {
    const old = notification("old", "2026-11-04T19:24:33.000Z");
    const replacement = notification("new", "2026-11-04T19:24:34.000Z");
    const snapshots = [[old], [replacement]];

    await closeNotificationsCoveredByMarkers(
      async () => snapshots.shift() ?? [replacement],
      new Map([[tag, marker]]),
    );

    expect(old.close).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("closes a current notification exactly at the inclusive marker", async () => {
    const current = notification("at-marker", "2026-11-04T19:24:33.000Z");

    await closeNotificationsCoveredByMarkers(
      async () => [current],
      new Map([[tag, marker]]),
    );

    expect(current.close).toHaveBeenCalledOnce();
  });

  it("waits for an asynchronous close boundary", async () => {
    const closeStarted = deferred<void>();
    const closed = deferred<void>();
    const current = {
      data: {
        conversationTag: tag,
        messageId: "async-close",
        messageTime: "2026-11-04T19:24:33.000Z",
      },
      close: vi.fn(() => {
        closeStarted.resolve();
        return closed.promise;
      }),
    };
    let settled = false;

    const cleanup = closeNotificationsCoveredByMarkers(
      async () => [current],
      new Map([[tag, marker]]),
    ).then(() => {
      settled = true;
    });
    await closeStarted.promise;
    await Promise.resolve();

    expect(current.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    closed.resolve();
    await cleanup;
    expect(settled).toBe(true);
  });

  it("closes only committed fallback replacements from the same conversation", async () => {
    const old = fallbackNotification(tag, "old");
    const current = fallbackNotification(tag, "current");
    const future = fallbackNotification(tag, "future");
    const other = fallbackNotification("Lounge/#other", "other");
    const visible = [old, current, future, other];

    await closeSupersededFallbackNotifications(
      async () => visible,
      tag,
      "current",
      new Set(["current", "future"]),
    );

    expect(old.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
    expect(future.close).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("keeps the current and newer receipts while closing older conversation notifications", async () => {
    const old = conversationNotification(tag, "old", "old-message");
    const current = conversationNotification(tag, "current", "current-message");
    const newer = conversationNotification(tag, "newer", "newer-message");
    const other = conversationNotification(
      "Lounge/#other",
      "other",
      "other-message",
    );
    const visible = [old, current, newer, other];

    await closeSupersededConversationNotifications(
      async () => visible,
      tag,
      currentIdentity(),
      new Set(["current", "newer"]),
    );

    expect(old.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
    expect(newer.close).not.toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
  });

  it("closes a tag-less deadline fallback after its detail is visible", async () => {
    const fallback = {
      data: { fallbackId: "current", receiptId: "current" },
      close: vi.fn(),
    };
    const detail = {
      data: {
        conversationTag: tag,
        fallbackId: "current",
        messageId: "current-message",
        messageTime: "2026-11-04T19:24:34.000Z",
        receiptId: "current",
      },
      close: vi.fn(),
    };

    await closeSupersededConversationNotifications(
      async () => [fallback, detail],
      tag,
      currentIdentity(),
      new Set(["current"]),
    );

    expect(fallback.close).toHaveBeenCalledOnce();
    expect(detail.close).not.toHaveBeenCalled();
  });

  it("does not close an identity replaced between its two bounded snapshots", async () => {
    const old = conversationNotification(tag, "old", "old-message");
    const replacement = conversationNotification(
      tag,
      "replacement",
      "replacement-message",
    );
    const snapshots = [[old], [replacement]];

    await closeSupersededConversationNotifications(
      async () => snapshots.shift() ?? [replacement],
      tag,
      currentIdentity(),
      new Set(["current"]),
    );

    expect(old.close).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("stops at the item bound without closing the current notification", async () => {
    const older = Array.from({ length: 65 }, (_, index) =>
      conversationNotification(tag, `old-${index}`, `old-message-${index}`),
    );
    const current = conversationNotification(tag, "current", "current-message");

    await closeSupersededConversationNotifications(
      async () => [...older, current],
      tag,
      currentIdentity(),
      new Set(["current"]),
    );

    expect(
      older.filter(({ close }) => close.mock.calls.length > 0),
    ).toHaveLength(64);
    expect(older.at(-1)?.close).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
  });

  it("keeps the current message identity when its receipt is unavailable", async () => {
    const old = conversationNotification(tag, "old", "old-message");
    const current = notification(
      "current-message",
      currentIdentity().messageTime,
    );

    await closeSupersededConversationNotifications(
      async () => [old, current],
      tag,
      currentIdentity(),
      new Set(["current"]),
    );

    expect(old.close).toHaveBeenCalledOnce();
    expect(current.close).not.toHaveBeenCalled();
  });
});

function notification(messageId: string, messageTime: string) {
  return {
    data: { conversationTag: tag, messageId, messageTime },
    close: vi.fn(),
  };
}

function fallbackNotification(conversationTag: string, fallbackId: string) {
  return {
    data: { conversationTag, fallbackId },
    close: vi.fn(),
  };
}

function conversationNotification(
  conversationTag: string,
  receiptId: string,
  messageId: string,
) {
  return {
    data: {
      conversationTag,
      messageId,
      messageTime: "2026-11-04T19:24:34.000Z",
      receiptId,
    },
    close: vi.fn(),
  };
}

function currentIdentity() {
  return {
    receiptId: "current",
    messageId: "current-message",
    messageTime: "2026-11-04T19:24:34.000Z",
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
} {
  let resolve: (value?: T) => void = () => {};
  const promise = new Promise<T>((fulfill) => {
    resolve = (value) => fulfill(value as T);
  });
  return { promise, resolve };
}
