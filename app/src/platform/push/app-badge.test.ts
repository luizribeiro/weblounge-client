import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import {
  appBadgeCount,
  clearAppPushState,
  closeMessageNotifications,
  closeReadConversationNotifications,
  conversationNotificationCounts,
  syncAppPushState,
} from "./app-badge";

it("counts unread direct messages once plus channel mentions", () => {
  expect(
    appBadgeCount([
      buffer({ kind: "direct", unread: 4, mentions: 4 }),
      buffer({ kind: "channel", unread: 12, mentions: 2 }),
      buffer({ kind: "server", unread: 3, mentions: 0 }),
    ]),
  ).toBe(6);
});

it("counts only known direct messages across a transcript gap", () => {
  expect(
    appBadgeCount([buffer({ kind: "direct", unread: 100, mentions: 2 })]),
  ).toBe(2);
});

it("maps engine counters to the notification tags shared with the worker", () => {
  expect(
    conversationNotificationCounts(
      [
        buffer({
          kind: "direct",
          network_id: 4,
          title: "Alice",
          unread: 3,
          mentions: 3,
        }),
        buffer({
          kind: "channel",
          network_id: 4,
          title: "#Lounge",
          unread: 9,
          mentions: 2,
        }),
        buffer({ kind: "server", unread: 0, mentions: 0 }),
      ],
      new Map([[4, "Lounge"]]),
    ),
  ).toEqual([
    { tag: "Lounge/alice", count: 3 },
    { tag: "Lounge/#lounge", count: 2 },
  ]);
});

it("stores only known direct messages across a transcript gap", () => {
  expect(
    conversationNotificationCounts(
      [
        buffer({
          kind: "direct",
          network_id: 4,
          title: "Alice",
          unread: 100,
          mentions: 2,
        }),
      ],
      new Map([[4, "Lounge"]]),
    ),
  ).toEqual([{ tag: "Lounge/alice", count: 2 }]);
});

it("closes only notifications at or before the engine read marker", async () => {
  const readNotification = { close: vi.fn() };
  const newerNotification = { close: vi.fn() };
  const unreadNotification = { close: vi.fn() };
  const getNotifications = vi.fn(
    async () =>
      [
        {
          ...readNotification,
          data: {
            conversationTag: "Lounge/#read",
            messageTime: "2026-11-04T19:24:32.000Z",
          },
        },
        {
          ...newerNotification,
          data: {
            conversationTag: "Lounge/#read",
            messageTime: "2026-11-04T19:24:34.000Z",
          },
        },
        {
          ...unreadNotification,
          data: {
            conversationTag: "Lounge/#unread",
            messageTime: "2026-11-04T19:24:32.000Z",
          },
        },
      ] as unknown as Notification[],
  );

  await closeReadConversationNotifications(
    [
      buffer({
        title: "#read",
        unread: 4,
        mentions: 1,
        read_at_ms: Date.parse("2026-11-04T19:24:33.000Z"),
      }),
      buffer({ title: "#unread", unread: 4, mentions: 1 }),
    ],
    new Map([[1, "Lounge"]]),
    {
      getRegistration: async () => ({
        getNotifications: getNotifications as unknown as (
          filter?: GetNotificationOptions,
        ) => Promise<Notification[]>,
      }),
    },
  );

  expect(getNotifications).toHaveBeenCalledOnce();
  expect(getNotifications).toHaveBeenCalledWith();
  expect(readNotification.close).toHaveBeenCalledOnce();
  expect(newerNotification.close).not.toHaveBeenCalled();
  expect(unreadNotification.close).not.toHaveBeenCalled();
});

function buffer(
  projection: Pick<BufferProjection, "unread" | "mentions"> &
    Partial<
      Pick<BufferProjection, "kind" | "network_id" | "title" | "read_at_ms">
    >,
): BufferProjection {
  return {
    id: 1,
    sync_state: "synced",
    title: projection.title ?? "buffer",
    draft_key: "draft",
    topic: null,
    ...projection,
    kind: projection.kind ?? "channel",
    network_id: projection.network_id ?? 1,
  };
}

it("closes pushed notifications whose message was deleted", async () => {
  const notification = (data: unknown) => ({ data, close: vi.fn() });
  const deleted = notification({ messageId: "gone", conversationTag: "L/#a" });
  const kept = notification({ messageId: "kept", conversationTag: "L/#a" });
  const untagged = notification(undefined);

  await closeMessageNotifications(["gone"], {
    getRegistration: async () => ({
      getNotifications: async () => [deleted, kept, untagged],
    }),
  });

  expect(deleted.close).toHaveBeenCalledOnce();
  expect(kept.close).not.toHaveBeenCalled();
  expect(untagged.close).not.toHaveBeenCalled();
});

it("writes the counts, then sets the badge through the host's notification center", async () => {
  const calls: unknown[] = [];
  const center = {
    badge: {
      setAppBadge: async (count?: number) => {
        calls.push(["set", count]);
      },
      clearAppBadge: async () => {
        calls.push(["clear"]);
      },
    },
    registrations: { getRegistration: async () => undefined },
    writeCounts: async (counts: readonly unknown[]) => {
      calls.push(["counts", counts]);
    },
  };
  const unread = buffer({
    kind: "direct",
    title: "Mel",
    unread: 2,
    mentions: 2,
  });
  const labels = new Map([[1, "Lounge"]]);

  await syncAppPushState([unread], labels, center);
  await syncAppPushState(
    [{ ...unread, unread: 0, mentions: 0 }],
    labels,
    center,
  );

  expect(calls).toEqual([
    ["counts", [{ tag: "Lounge/mel", count: 2 }]],
    ["set", 2],
    ["counts", [{ tag: "Lounge/mel", count: 0 }]],
    ["clear"],
  ]);
});

it("withdraws every delivered notification, the counts and the badge", async () => {
  const calls: unknown[] = [];
  const delivered = [
    { data: { conversationTag: "Lounge/mel" }, close: vi.fn() },
    { data: undefined, close: vi.fn() },
  ];
  await clearAppPushState({
    badge: {
      setAppBadge: async (count?: number) => {
        calls.push(["set", count]);
      },
      clearAppBadge: async () => {
        calls.push(["clear"]);
      },
    },
    registrations: {
      getRegistration: async () => ({
        getNotifications: async () => delivered,
      }),
    },
    writeCounts: async (counts: readonly unknown[]) => {
      calls.push(["counts", counts]);
    },
  });

  for (const notification of delivered)
    expect(notification.close).toHaveBeenCalledOnce();
  expect(calls).toEqual([["counts", []], ["clear"]]);
});
