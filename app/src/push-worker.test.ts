import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  schedulePushPresentation,
  showOnce,
} from "./platform/push/push-delivery-state";
import {
  deadlineFallbackNotification,
  genericNotification,
} from "./platform/push/push-notification";
import {
  notificationDataIsRead,
  recordPresentedNotification,
} from "./platform/push/push-notification-state";

describe("push delivery state", () => {
  it("keeps a successful presentation live while persistence crosses its deadline", async () => {
    vi.useFakeTimers();
    try {
      const present = vi.fn(async (_value: string) => undefined);
      const state = schedulePushPresentation<string>(
        "generic",
        present,
        1_500,
        2_000,
        () => undefined,
      );

      await showOnce(state, "detailed");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(state.fallback).resolves.toBeUndefined();

      expect(state.expired).toBe(false);
      expect(state.shown).toBe(true);
      expect(present).toHaveBeenCalledExactlyOnceWith("detailed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a read marker in force when a newer same-tag message is shown", () => {
    const tag = "Lounge/#lounge";
    const time = "2026-11-03T12:34:56.789Z";
    const counts = {
      conversations: new Map([
        [tag, { unknown: 0, messages: new Map<string, number>() }],
      ]),
      readAtMs: new Map([[tag, Date.parse(time)]]),
      untagged: 0,
    };
    const older = { conversationTag: tag, messageTime: time };
    const newer = {
      conversationTag: tag,
      messageTime: "2026-11-03T12:34:56.790Z",
    };
    expect(notificationDataIsRead(older, counts.readAtMs)).toBe(true);

    recordPresentedNotification(counts, {
      tag,
      messageId: "new-message",
      messageTime: newer.messageTime,
    });

    expect(counts.conversations.get(tag)?.messages.size).toBe(1);
    expect(notificationDataIsRead(newer, counts.readAtMs)).toBe(false);
    expect(notificationDataIsRead(older, counts.readAtMs)).toBe(true);
  });
});

describe("push worker notification presentation", () => {
  it("prevents platform default routing before handling a notification tap", () => {
    const source = readFileSync("src/push-worker.ts", "utf8");
    const preventDefault = source.indexOf("click.preventDefault();");
    const routeClick = source.indexOf(
      "click.waitUntil(routeNotificationClick(worker.clients, click.notification));",
    );

    expect(preventDefault).toBeGreaterThan(-1);
    expect(routeClick).toBeGreaterThan(preventDefault);
  });

  it("uses a generic notification without a body for an unknown route", () => {
    expect(genericNotification()).toEqual({
      title: "New message",
      options: { data: { route: "/" } },
    });
  });

  it("marks only a deadline fallback for later replacement", () => {
    expect(genericNotification(undefined, "receipt")).toEqual({
      title: "New message",
      options: { data: { route: "/", receiptId: "receipt" } },
      receiptId: "receipt",
    });
    expect(
      deadlineFallbackNotification(
        genericNotification("Lounge", "receipt"),
        "receipt",
      ),
    ).toEqual({
      title: "New message",
      options: {
        body: "Lounge",
        tag: "weblounge-fallback/receipt",
        data: {
          route: "/",
          receiptId: "receipt",
          fallbackId: "receipt",
        },
      },
      receiptId: "receipt",
      fallbackId: "receipt",
    });
  });
});
