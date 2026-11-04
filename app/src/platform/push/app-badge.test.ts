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
    conversationNotificationCounts([
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
    ]),
  ).toEqual([
    { tag: "4/alice", count: 3 },
    { tag: "4/#lounge", count: 2 },
  ]);
});

it("closes notifications only for conversations the engine says are read", async () => {
  const readNotification = { close: vi.fn() };
  const unreadNotification = { close: vi.fn() };
  const getNotifications = vi.fn(async ({ tag }: GetNotificationOptions) =>
    tag === "1/#read" ? [readNotification] : [unreadNotification],
  );

  await closeReadConversationNotifications(
    [
      buffer({ title: "#read", unread: 4, mentions: 0 }),
      buffer({ title: "#unread", unread: 4, mentions: 1 }),
    ],
    {
      getRegistration: async () => ({
        getNotifications: getNotifications as unknown as (
          filter?: GetNotificationOptions,
        ) => Promise<Notification[]>,
      }),
    },
  );

  expect(getNotifications).toHaveBeenCalledOnce();
  expect(getNotifications).toHaveBeenCalledWith({ tag: "1/#read" });
  expect(readNotification.close).toHaveBeenCalledOnce();
  expect(unreadNotification.close).not.toHaveBeenCalled();
});

function buffer(
  projection: Pick<BufferProjection, "unread" | "mentions"> &
    Partial<Pick<BufferProjection, "kind" | "network_id" | "title">>,
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
