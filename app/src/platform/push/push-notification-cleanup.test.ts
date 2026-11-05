import { describe, expect, it, vi } from "vitest";
import {
  closeNotificationsCoveredByMarkers,
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
