import { expect, it, vi } from "vitest";
import type { BufferProjection } from "../../engine/protocol";
import {
  appBadgeCount,
  closeReadConversationNotifications,
  conversationNotificationCounts,
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
    read_through: null,
    ...projection,
    kind: projection.kind ?? "channel",
    network_id: projection.network_id ?? 1,
  };
}
